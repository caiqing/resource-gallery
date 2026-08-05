import { Hono } from "hono";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { getDb, id, nowIso } from "../db/client.js";
import { processImportJob } from "../lib/import.js";
import { MultipartUploadError, streamZipMultipartUpload } from "../lib/stream-upload.js";
import {
  autoPublishListing,
  finishSyncRun,
  parseSyncError,
  requireSyncClient,
  startSyncRun,
  syncPolicy,
  updateSyncState
} from "../lib/sync.js";

export const syncRoutes = new Hono();

function syncError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "同步请求失败";
  const status = message === "SYNC_UNAUTHORIZED" ? 401
    : message === "SYNC_DISABLED" ? 404
      : ["SYNC_NOT_CONFIGURED", "SYNC_ACTOR_NOT_CONFIGURED", "SYNC_ACTOR_NOT_FOUND"].includes(message) ? 503
        : 400;
  return Response.json({ error: message }, { status });
}

syncRoutes.post("/runs", async (c) => {
  try {
    requireSyncClient(c);
    const body = await c.req.json().catch(() => ({}));
    const runId = startSyncRun(syncPolicy(body.publish_policy), String(body.source ?? "video2ppt"));
    return c.json({ run_id: runId, publish_policy: syncPolicy(body.publish_policy) }, 201);
  } catch (error) {
    return syncError(error);
  }
});

syncRoutes.patch("/runs/:id", async (c) => {
  try {
    requireSyncClient(c);
    const body = await c.req.json().catch(() => ({}));
    finishSyncRun(c.req.param("id"), {
      status: body.status === "failed" ? "failed" : "succeeded",
      scanned: Number(body.scanned ?? 0),
      changed: Number(body.changed ?? 0),
      unchanged: Number(body.unchanged ?? 0),
      imported: Number(body.imported ?? 0),
      review: Number(body.review ?? 0),
      published: Number(body.published ?? 0),
      failed: Number(body.failed ?? 0),
      message: String(body.message ?? "")
    });
    return c.json({ ok: true });
  } catch (error) {
    return syncError(error);
  }
});

syncRoutes.get("/runs/:id", (c) => {
  try {
    requireSyncClient(c);
    const row = getDb().prepare(`SELECT * FROM resource_sync_runs WHERE id = ?`).get(c.req.param("id"));
    return row ? c.json({ run: row }) : c.json({ error: "not found" }, 404);
  } catch (error) {
    return syncError(error);
  }
});

syncRoutes.get("/states/:taskId", (c) => {
  try {
    requireSyncClient(c);
    const row = getDb().prepare(`SELECT * FROM resource_sync_states WHERE source_task_id = ?`).get(c.req.param("taskId"));
    return row ? c.json({ state: row }) : c.json({ error: "not found" }, 404);
  } catch (error) {
    return syncError(error);
  }
});

syncRoutes.get("/metrics", (c) => {
  try {
    requireSyncClient(c);
    const db = getDb();
    const count = (sql: string, ...params: string[]) => Number((db.prepare(sql).get(...params) as { count: number }).count);
    const scalar = (sql: string, ...params: string[]) => {
      const value = (db.prepare(sql).get(...params) as { value?: number | null }).value;
      return Number.isFinite(Number(value)) ? Number(value) : 0;
    };
    const oldestReviewAgeSeconds = Math.max(0, Math.floor(scalar(
      `SELECT COALESCE(MAX((julianday('now') - julianday(updated_at)) * 86400), 0) AS value
       FROM resource_sync_states WHERE status = 'review'`
    )));
    const gateReviews = count(
      `SELECT COUNT(*) AS count FROM resource_sync_states
       WHERE status = 'review' AND last_error_code IS NOT NULL AND last_error_code <> ''`
    );
    const lines = [
      "# HELP resource_gallery_sync_runs_total Synchronization runs by terminal status.",
      "# TYPE resource_gallery_sync_runs_total gauge",
      `resource_gallery_sync_runs_total{status=\"running\"} ${count("SELECT COUNT(*) AS count FROM resource_sync_runs WHERE status = 'running'")}`,
      `resource_gallery_sync_runs_total{status=\"succeeded\"} ${count("SELECT COUNT(*) AS count FROM resource_sync_runs WHERE status = 'succeeded'")}`,
      `resource_gallery_sync_runs_total{status=\"failed\"} ${count("SELECT COUNT(*) AS count FROM resource_sync_runs WHERE status = 'failed'")}`,
      "# HELP resource_gallery_sync_states_total Synchronization task states.",
      "# TYPE resource_gallery_sync_states_total gauge",
      ...["pending", "running", "review", "published", "failed"].map((status) =>
        `resource_gallery_sync_states_total{status=\"${status}\"} ${count("SELECT COUNT(*) AS count FROM resource_sync_states WHERE status = ?", status)}`
      ),
      "# HELP resource_gallery_import_jobs_total Import jobs by status.",
      "# TYPE resource_gallery_import_jobs_total gauge",
      ...["pending", "processing", "succeeded", "failed"].map((status) =>
        `resource_gallery_import_jobs_total{status=\"${status}\"} ${count("SELECT COUNT(*) AS count FROM import_jobs WHERE status = ?", status)}`
      ),
      "# HELP resource_gallery_sync_review_oldest_age_seconds Age of the oldest task awaiting review.",
      "# TYPE resource_gallery_sync_review_oldest_age_seconds gauge",
      `resource_gallery_sync_review_oldest_age_seconds ${oldestReviewAgeSeconds}`,
      "# HELP resource_gallery_sync_gate_reviews_total Review states blocked by an automatic publish gate.",
      "# TYPE resource_gallery_sync_gate_reviews_total gauge",
      `resource_gallery_sync_gate_reviews_total ${gateReviews}`
    ];
    return new Response(`${lines.join("\n")}\n`, { headers: { "content-type": "text/plain; version=0.0.4" } });
  } catch (error) {
    return syncError(error);
  }
});

syncRoutes.post("/packages", async (c) => {
  let uploadPath = "";
  let jobId = "";
  try {
    const auth = requireSyncClient(c);
    const runId = c.req.header("x-resource-gallery-sync-run-id") ?? null;
    const taskIdHeader = c.req.header("x-resource-gallery-task-id")?.trim() ?? "";
    const trackState = c.req.header("x-resource-gallery-track-state") !== "false";
    if (!taskIdHeader) return c.json({ error: "缺少 x-resource-gallery-task-id" }, 400);
    jobId = id("job");
    uploadPath = join(config.uploadRoot, `sync-${jobId}.zip`);
    mkdirSync(config.uploadRoot, { recursive: true });
    const upload = await streamZipMultipartUpload(c.req.raw, uploadPath, config.maxPackageBytes);
    getDb().prepare(
      `INSERT INTO import_jobs (id, admin_user_id, filename, status, message, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    ).run(jobId, auth.actorId, upload.filename || `${jobId}.zip`, runId ? `sync_run:${runId}` : "machine sync", nowIso());
    const previous = trackState
      ? getDb().prepare(`SELECT attempt_count FROM resource_sync_states WHERE source_task_id = ?`).get(taskIdHeader) as { attempt_count: number } | undefined
      : undefined;
    if (trackState) {
      updateSyncState({ taskId: taskIdHeader, policy: auth.policy, status: "running", attemptCount: (previous?.attempt_count ?? 0) + 1 });
    }
    await processImportJob(jobId, uploadPath, { expectedTaskId: taskIdHeader });
    const job = getDb().prepare(`SELECT id, status, message, listing_id, source_task_id, source_run_id FROM import_jobs WHERE id = ?`).get(jobId) as {
      id: string; status: string; message: string; listing_id: string | null; source_task_id: string | null; source_run_id: string | null;
    };
    const taskId = job.source_task_id ?? taskIdHeader;
    if (job.status !== "succeeded" || !job.listing_id) {
      const parsed = parseSyncError(new Error(job.message || "同步导入失败"));
      if (trackState) {
        updateSyncState({ taskId, policy: auth.policy, status: "failed", attemptCount: (previous?.attempt_count ?? 0) + 1, errorCode: parsed.code, errorMessage: parsed.message });
      }
      return c.json({ ok: false, job, error_code: parsed.code, error: parsed.message }, 422);
    }
    const version = getDb().prepare(
      `SELECT id, package_sha256, export_fingerprint, status FROM listing_versions
       WHERE listing_id = ? AND source_run_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(job.listing_id, job.source_run_id) as { id: string; package_sha256: string; export_fingerprint: string; status: string } | undefined;
    let status: "review" | "published" = "review";
    let gate: ReturnType<typeof autoPublishListing> | null = null;
    if (auth.policy === "auto_publish" && version?.status === "draft") {
      gate = autoPublishListing(job.listing_id, auth.actorId);
      if (gate.ok) status = "published";
    } else if (version?.status === "active") {
      status = "published";
    }
    if (trackState) {
      updateSyncState({
        taskId,
        listingId: job.listing_id,
        versionId: version?.id ?? null,
        fingerprint: version?.export_fingerprint ?? null,
        packageSha: version?.package_sha256 ?? null,
        policy: auth.policy,
        status,
        attemptCount: (previous?.attempt_count ?? 0) + 1,
        errorCode: gate && !gate.ok ? gate.code : null,
        errorMessage: gate && !gate.ok ? gate.message : "",
        syncedAt: status === "published" ? nowIso() : null
      });
    }
    return c.json({ ok: true, job, version: version ?? null, status, gate, state_tracked: trackState });
  } catch (error) {
    const parsed = parseSyncError(error);
    if (jobId) {
      const job = getDb().prepare(`SELECT source_task_id FROM import_jobs WHERE id = ?`).get(jobId) as { source_task_id: string | null } | undefined;
      const taskId = job?.source_task_id ?? c.req.header("x-resource-gallery-task-id")?.trim();
      if (taskId && c.req.header("x-resource-gallery-track-state") !== "false") {
        updateSyncState({ taskId, policy: syncPolicy(c.req.header("x-resource-gallery-publish-policy")), status: "failed", errorCode: parsed.code, errorMessage: parsed.message });
      }
    }
    if (error instanceof MultipartUploadError) return c.json({ error: parsed.message }, error.status);
    return c.json({ error_code: parsed.code, error: parsed.message }, 500);
  } finally {
    if (uploadPath) rmSync(uploadPath, { force: true });
  }
});

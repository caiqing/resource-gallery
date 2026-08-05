import { Hono } from "hono";
import { mkdirSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { extname, join } from "node:path";
import { config } from "../config.js";
import { getDb, id, nowIso, withTransaction } from "../db/client.js";
import { blobStore } from "../lib/blob-store.js";
import { isPreviewableArtifact, processImportJob } from "../lib/import.js";
import { backfillMissingListingSummaries } from "../lib/summary-backfill.js";
import { backfillListingTags } from "../lib/tag-backfill.js";
import {
  publicSummaryLlmSettings,
  summaryLlmOptions,
  updateSummaryLlmSettings,
  type PublicSummaryLlmSettings
} from "../lib/llm-settings.js";
import { listSummaryLlmModels, testSummaryLlmConnections } from "../lib/summary.js";
import { MultipartUploadError, streamZipMultipartUpload } from "../lib/stream-upload.js";
import { requireAdmin } from "../middleware/auth.js";
import { parseByteRange } from "../lib/http-range.js";

export const adminRoutes = new Hono();

function llmSettingsPayload(settings: PublicSummaryLlmSettings) {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    api_base: settings.apiBase,
    api_key_configured: settings.apiKeyConfigured,
    api_key: "",
    model: settings.model,
    fallback_models: settings.fallbackModels,
    timeout_ms: settings.timeoutMs,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens
  };
}

function adminPreviewContentType(filename: string, mimeType?: string | null): string {
  if (mimeType) return mimeType;
  const suffix = extname(filename).toLowerCase();
  return {
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".webm": "video/webm"
  }[suffix] ?? "application/octet-stream";
}

function adminPreviewDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, "_").replace(/[\\"\r\n]/g, "_") || "preview";
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

adminRoutes.use("*", async (c, next) => {
  try {
    requireAdmin(c);
    await next();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHORIZED") return c.json({ error: "login required" }, 401);
    if (msg === "FORBIDDEN") return c.json({ error: "admin only" }, 403);
    throw e;
  }
});

adminRoutes.get("/overview", (c) => {
  const db = getDb();
  const published = db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE status = 'published'`).get() as { c: number };
  const draft = db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE status = 'draft'`).get() as { c: number };
  const jobs = db.prepare(`SELECT COUNT(*) AS c FROM import_jobs`).get() as { c: number };
  const users = db.prepare(`SELECT COUNT(*) AS c FROM users`).get() as { c: number };
  const openReports = db.prepare(`SELECT COUNT(*) AS c FROM reports WHERE status = 'open'`).get() as { c: number };
  const failedImports = db.prepare(`SELECT COUNT(*) AS c FROM import_jobs WHERE status = 'failed'`).get() as { c: number };
  return c.json({
    published: published.c,
    draft: draft.c,
    import_jobs: jobs.c,
    users: users.c,
    open_reports: openReports.c,
    failed_imports: failedImports.c
  });
});

adminRoutes.get("/llm/settings", (c) => {
  return c.json({ settings: llmSettingsPayload(publicSummaryLlmSettings()) });
});

adminRoutes.put("/llm/settings", async (c) => {
  const admin = requireAdmin(c);
  const body = await c.req.json().catch(() => ({}));
  let settings: PublicSummaryLlmSettings;
  try {
    settings = updateSummaryLlmSettings({
      enabled: body.enabled !== false,
      provider: String(body.provider ?? "openai-compatible"),
      apiBase: String(body.api_base ?? ""),
      apiKey: body.api_key == null ? undefined : String(body.api_key),
      model: String(body.model ?? ""),
      fallbackModels: Array.isArray(body.fallback_models)
        ? body.fallback_models.map(String)
        : [],
      timeoutMs: Number(body.timeout_ms ?? 20_000),
      temperature: Number(body.temperature ?? 0.2),
      maxTokens: Number(body.max_tokens ?? 240)
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "模型配置无效" }, 400);
  }

  const ts = nowIso();
  getDb().prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, 'llm.settings.update', 'system_config', 'summary_llm', ?, ?)`
  ).run(
    id("aud"),
    admin.id,
    JSON.stringify({
      enabled: settings.enabled,
      provider: settings.provider,
      api_base: settings.apiBase,
      model: settings.model,
      fallback_models: settings.fallbackModels,
      timeout_ms: settings.timeoutMs,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      api_key_updated: Boolean(String(body.api_key ?? "").trim())
    }),
    ts
  );

  const backfillScheduled = settings.enabled && settings.apiKeyConfigured;
  if (backfillScheduled) {
    void backfillMissingListingSummaries(500).then((result) => {
      getDb().prepare(
        `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
         VALUES (?, ?, 'listing.summary_backfill', 'listing_batch', ?, ?, ?)`
      ).run(
        id("aud"),
        admin.id,
        `batch_${nowIso()}`,
        JSON.stringify({ ...result, source: "llm_settings_update" }),
        nowIso()
      );
    }).catch((error) => {
      console.error(JSON.stringify({
        level: "error",
        event: "listing.summary_backfill_failed",
        source: "llm_settings_update",
        error: error instanceof Error ? error.message : "unknown error"
      }));
    });
    void backfillListingTags(500).then((result) => {
      getDb().prepare(
        `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
         VALUES (?, ?, 'listing.tag_backfill', 'listing_batch', ?, ?, ?)`
      ).run(
        id("aud"),
        admin.id,
        `batch_${nowIso()}`,
        JSON.stringify({ ...result, source: "llm_settings_update" }),
        nowIso()
      );
    }).catch((error) => {
      console.error(JSON.stringify({
        level: "error",
        event: "listing.tag_backfill_failed",
        source: "llm_settings_update",
        error: error instanceof Error ? error.message : "unknown error"
      }));
    });
  }

  return c.json({
    settings: llmSettingsPayload(settings),
    backfill_scheduled: backfillScheduled
  });
});

adminRoutes.get("/llm/models", async (c) => {
  try {
    return c.json({ models: await listSummaryLlmModels(summaryLlmOptions()) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "模型列表加载失败" }, 502);
  }
});

adminRoutes.post("/llm/models", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const options = summaryLlmOptions({
      apiBase: body.api_base == null ? undefined : String(body.api_base),
      apiKey: body.api_key == null ? undefined : String(body.api_key),
      timeoutMs: body.timeout_ms == null ? undefined : Number(body.timeout_ms)
    });
    return c.json({ models: await listSummaryLlmModels(options) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "模型列表加载失败" }, 502);
  }
});

adminRoutes.post("/llm/test", async (c) => {
  try {
    return c.json(await testSummaryLlmConnections(summaryLlmOptions()));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "模型连接测试失败" }, 502);
  }
});

adminRoutes.get("/import-jobs", (c) => {
  const rows = getDb()
    .prepare(
      `SELECT id, filename, status, message, listing_id, source_task_id, source_run_id, created_at, finished_at
       FROM import_jobs ORDER BY created_at DESC LIMIT 100`
    )
    .all();
  return c.json({ jobs: rows });
});

adminRoutes.post("/import-jobs", async (c) => {
  const admin = requireAdmin(c);
  const jobId = id("job");
  const uploadPath = join(config.uploadRoot, `${jobId}.zip`);
  mkdirSync(config.uploadRoot, { recursive: true });
  let upload: { filename: string };
  try {
    upload = await streamZipMultipartUpload(c.req.raw, uploadPath, config.maxPackageBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "上传失败";
    return c.json({ error: message }, error instanceof MultipartUploadError ? error.status : 400);
  }

  getDb()
    .prepare(
      `INSERT INTO import_jobs (
        id, admin_user_id, filename, status, message, created_at
      ) VALUES (?, ?, ?, 'pending', '', ?)`
    )
    .run(jobId, admin.id, upload.filename || `${jobId}.zip`, nowIso());

  try {
    // Inline execution keeps the MVP deterministic; ImportJob still exposes explicit lifecycle state.
    await processImportJob(jobId, uploadPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "import failed";
    const ts = nowIso();
    getDb().prepare(
      `UPDATE import_jobs SET status = 'failed', message = ?, finished_at = ? WHERE id = ?`
    ).run(message.slice(0, 1000), ts, jobId);
    getDb().prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'import.failed', 'import_job', ?, ?, ?)`
    ).run(id("aud"), admin.id, jobId, JSON.stringify({ message }), ts);
  } finally {
    rmSync(uploadPath, { force: true });
  }

  const job = getDb().prepare(`SELECT * FROM import_jobs WHERE id = ?`).get(jobId);
  return c.json({ job });
});

adminRoutes.get("/listings", (c) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT l.id, l.title, l.status, l.price_tier, l.price_credits, l.source_task_id, l.source_run_id, l.updated_at
       FROM listings l
       ORDER BY l.updated_at DESC
       LIMIT 200`
    )
    .all();
  const draftCount = db
    .prepare(`SELECT COUNT(*) AS count FROM listings WHERE status = 'draft'`)
    .get() as { count: number };
  return c.json({ listings: rows, draft_count: draftCount.count });
});

adminRoutes.post("/listings/publish-all", (c) => {
  const admin = requireAdmin(c);
  const db = getDb();
  const drafts = db
    .prepare(
      `SELECT l.id, l.title,
              (SELECT v.id FROM listing_versions v
               WHERE v.listing_id = l.id AND v.status = 'draft'
               ORDER BY v.created_at DESC LIMIT 1) AS draft_version_id,
              (SELECT v.cover_path FROM listing_versions v
               WHERE v.listing_id = l.id AND v.status = 'draft'
               ORDER BY v.created_at DESC LIMIT 1) AS draft_cover_path,
              EXISTS (
                SELECT 1 FROM listing_files f
                WHERE f.listing_id = l.id AND f.stripped = 0 AND f.included = 1
              ) OR EXISTS (
                SELECT 1 FROM listing_assets a
                JOIN listing_versions v ON v.id = a.version_id
                WHERE v.listing_id = l.id AND v.status = 'draft'
                  AND a.stripped = 0 AND a.included = 1
              ) AS has_usable_files
       FROM listings l
       WHERE l.status = 'draft'
       ORDER BY l.updated_at DESC`
    )
    .all() as { id: string; title: string; draft_version_id: string | null; draft_cover_path: string | null; has_usable_files: number }[];

  const publishable = drafts.filter((listing) => listing.has_usable_files === 1);
  const skipped = drafts
    .filter((listing) => listing.has_usable_files !== 1)
    .map((listing) => ({ id: listing.id, title: listing.title, reason: "no_usable_files" }));
  const ts = nowIso();

  withTransaction(() => {
    const publish = db.prepare(
      `UPDATE listings
       SET status = 'published', active_version_id = COALESCE(?, active_version_id),
           cover_path = COALESCE(?, cover_path), published_at = COALESCE(published_at, ?), updated_at = ?
       WHERE id = ? AND status = 'draft'`
    );
    const audit = db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'listing.publish', 'listing', ?, ?, ?)`
    );

    for (const listing of publishable) {
      if (listing.draft_version_id) {
        db.prepare(`UPDATE listing_versions SET status = 'superseded' WHERE listing_id = ? AND status = 'active'`).run(listing.id);
        db.prepare(`UPDATE listing_versions SET status = 'active', activated_at = ? WHERE id = ?`).run(ts, listing.draft_version_id);
      }
      publish.run(listing.draft_version_id, listing.draft_cover_path, ts, ts, listing.id);
      audit.run(
        id("aud"),
        admin.id,
        listing.id,
        JSON.stringify({ from_status: "draft", source: "publish_all", active_version_id: listing.draft_version_id }),
        ts
      );
    }

    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'listing.publish_all', 'listing_batch', ?, ?, ?)`
    ).run(
      id("aud"),
      admin.id,
      `batch_${ts}`,
      JSON.stringify({ published_count: publishable.length, skipped }),
      ts
    );
  });

  return c.json({
    ok: true,
    draft_count: drafts.length,
    published_count: publishable.length,
    skipped_count: skipped.length,
    skipped
  });
});

adminRoutes.post("/listings/backfill-summaries", async (c) => {
  const admin = requireAdmin(c);
  const body = await c.req.json().catch(() => ({}));
  const limit = Number.isSafeInteger(Number(body.limit)) ? Number(body.limit) : 100;
  const result = await backfillMissingListingSummaries(limit, {
    forceFallback: body.force_fallback === true
  });
  const ts = nowIso();
  getDb().prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, 'listing.summary_backfill', 'listing_batch', ?, ?, ?)`
  ).run(
    id("aud"),
    admin.id,
    `batch_${ts}`,
    JSON.stringify({ ...result, force_fallback: body.force_fallback === true }),
    ts
  );
  return c.json({ ok: true, ...result });
});

adminRoutes.post("/listings/backfill-tags", async (c) => {
  const admin = requireAdmin(c);
  const body = await c.req.json().catch(() => ({}));
  const limit = Number.isSafeInteger(Number(body.limit)) ? Number(body.limit) : 500;
  const result = await backfillListingTags(limit);
  const ts = nowIso();
  getDb().prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, 'listing.tag_backfill', 'listing_batch', ?, ?, ?)`
  ).run(id("aud"), admin.id, `batch_${ts}`, JSON.stringify(result), ts);
  return c.json({ ok: true, ...result });
});

adminRoutes.get("/listings/:id", (c) => {
  const db = getDb();
  const listing = db.prepare(`SELECT * FROM listings WHERE id = ?`).get(c.req.param("id"));
  if (!listing) return c.json({ error: "not found" }, 404);
  const files = db
    .prepare(`SELECT * FROM listing_files WHERE listing_id = ? ORDER BY stripped ASC, filename`)
    .all(c.req.param("id"));
  const tags = db
    .prepare(`SELECT tag, topic_id FROM listing_tags WHERE listing_id = ?`)
    .all(c.req.param("id"));
  const versions = db
    .prepare(`SELECT * FROM listing_versions WHERE listing_id = ? ORDER BY created_at DESC`)
    .all(c.req.param("id"));
  const assets = db
    .prepare(
      `SELECT a.* FROM listing_assets a
       JOIN listing_versions v ON v.id = a.version_id
       WHERE v.listing_id = ? ORDER BY v.created_at DESC, a.filename`
    )
    .all(c.req.param("id"));
  return c.json({ listing, files, tags, versions, assets });
});

adminRoutes.get("/listings/:id/preview", async (c) => {
  const listingId = c.req.param("id");
  const filename = c.req.query("file") ?? "";
  if (!filename) return c.json({ error: "file required" }, 400);
  const db = getDb();
  const listing = db.prepare(`SELECT id, active_version_id FROM listings WHERE id = ?`).get(listingId) as
    | { id: string; active_version_id: string | null }
    | undefined;
  if (!listing) return c.json({ error: "not found" }, 404);

  const requestedVersion = c.req.query("version_id") ?? "";
  const draftVersion = db.prepare(
    `SELECT id FROM listing_versions WHERE listing_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`
  ).get(listingId) as { id: string } | undefined;
  const versionId = requestedVersion || draftVersion?.id || listing.active_version_id || "";
  const asset = versionId
    ? db.prepare(
        `SELECT a.filename, a.storage_path, a.mime_type
         FROM listing_assets a JOIN listing_versions v ON v.id = a.version_id
         WHERE v.listing_id = ? AND a.version_id = ? AND a.filename = ? AND a.stripped = 0`
      ).get(listingId, versionId, filename) as { filename: string; storage_path: string; mime_type: string | null } | undefined
    : db.prepare(
        `SELECT filename, storage_path, NULL AS mime_type FROM listing_files
         WHERE listing_id = ? AND filename = ? AND stripped = 0`
      ).get(listingId, filename) as { filename: string; storage_path: string; mime_type: string | null } | undefined;
  if (!asset) return c.json({ error: "preview unavailable" }, 404);

  let source;
  try {
    source = await blobStore.open(listingId, asset.storage_path);
  } catch {
    return c.json({ error: "blob missing" }, 404);
  }
  const headers = {
    "content-type": adminPreviewContentType(asset.filename, asset.mime_type),
    "accept-ranges": "bytes",
    "content-disposition": adminPreviewDisposition(asset.filename),
    "cache-control": "no-store"
  };
  const range = c.req.header("range");
  if (!range) {
    return new Response(Readable.toWeb(source.stream) as any, {
      headers: { ...headers, "content-length": String(source.size) }
    });
  }
  const parsedRange = parseByteRange(range, source.size);
  if (!parsedRange) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${source.size}` } });
  }
  const { start, end } = parsedRange;
  try {
    const ranged = await blobStore.open(listingId, asset.storage_path, { start, end });
    return new Response(Readable.toWeb(ranged.stream) as any, {
      status: 206,
      headers: {
        ...headers,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${source.size}`
      }
    });
  } catch {
    return c.json({ error: "blob missing" }, 404);
  }
});

adminRoutes.patch("/listings/:id", async (c) => {
  const admin = requireAdmin(c);
  const listingId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();
  const listing = db.prepare(`SELECT * FROM listings WHERE id = ?`).get(listingId) as any;
  if (!listing) return c.json({ error: "not found" }, 404);

  const title = body.title != null ? String(body.title).trim() : listing.title;
  const summary = body.summary != null ? String(body.summary).trim() : listing.summary;
  const summaryChanged = body.summary != null && summary !== listing.summary;
  const tagsChanged = Array.isArray(body.tags);
  if (!title || title.length > 120 || summary.length > 1000) {
    return c.json({ error: "标题或摘要长度无效" }, 400);
  }
  const priceTier = body.price_tier != null ? String(body.price_tier) : listing.price_tier;
  const tier = db.prepare(`SELECT credits FROM price_tiers WHERE id = ?`).get(priceTier) as
    | { credits: number }
    | undefined;
  if (!tier) return c.json({ error: "invalid price tier" }, 400);
  const priceCredits = tier.credits;
  const status = body.status != null ? String(body.status) : listing.status;
  if (!["draft", "published", "unlisted", "taken_down"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  const transitions: Record<string, string[]> = {
    draft: ["draft"],
    published: ["published", "unlisted", "taken_down"],
    unlisted: ["unlisted", "taken_down"],
    taken_down: ["taken_down", "draft"]
  };
  if (!transitions[listing.status]?.includes(status)) {
    return c.json({ error: `invalid transition ${listing.status} -> ${status}` }, 409);
  }

  const ts = nowIso();
  const publishedAt =
    status === "published"
      ? listing.published_at ?? ts
      : listing.published_at;

  withTransaction(() => {
    db.prepare(
      `UPDATE listings
       SET title = ?, summary = ?,
           summary_status = CASE WHEN ? THEN 'ready' ELSE summary_status END,
           summary_origin = CASE WHEN ? THEN 'operator' ELSE summary_origin END,
           summary_locked = CASE WHEN ? THEN 1 ELSE summary_locked END,
           tag_origin = CASE WHEN ? THEN 'operator' ELSE tag_origin END,
           tag_locked = CASE WHEN ? THEN 1 ELSE tag_locked END,
           price_tier = ?, price_credits = ?, status = ?, published_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      title,
      summary,
      summaryChanged ? 1 : 0,
      summaryChanged ? 1 : 0,
      summaryChanged ? 1 : 0,
      tagsChanged ? 1 : 0,
      tagsChanged ? 1 : 0,
      priceTier,
      priceCredits,
      status,
      publishedAt,
      ts,
      listingId
    );

    if (Array.isArray(body.included_file_ids)) {
      const ids = new Set(body.included_file_ids.map(String));
      const files = db
        .prepare(`SELECT id, kind, filename, is_previewable, stripped FROM listing_files WHERE listing_id = ?`)
        .all(listingId) as { id: string; kind: string; filename: string; is_previewable: number; stripped: number }[];
      for (const file of files) {
        const included = !file.stripped && ids.has(file.id) ? 1 : 0;
        const publicPreview = included && (file.is_previewable === 1 || /\.(md|markdown|mdx|txt)$/i.test(file.filename)) ? "public" : "none";
        db.prepare(`UPDATE listing_files SET included = ? WHERE id = ?`).run(
          included,
          file.id
        );
        db.prepare(
          `UPDATE listing_assets SET included = ?, preview_policy = ?
           WHERE id = ? AND stripped = 0`
        ).run(included, publicPreview, file.id);
      }
    }

    if (Array.isArray(body.included_asset_ids)) {
      const versionId = body.version_id != null
        ? String(body.version_id)
        : (db.prepare(
            `SELECT id FROM listing_versions WHERE listing_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`
          ).get(listingId) as { id: string } | undefined)?.id;
      if (!versionId) throw new Error("没有可编辑的草稿版本");
      const version = db.prepare(`SELECT id FROM listing_versions WHERE id = ? AND listing_id = ? AND status = 'draft'`)
        .get(versionId, listingId) as { id: string } | undefined;
      if (!version) throw new Error("只能编辑当前 Listing 的草稿版本");
      const ids = new Set(body.included_asset_ids.map(String));
      const assets = db.prepare(`SELECT id, kind, filename, stripped FROM listing_assets WHERE version_id = ?`).all(versionId) as { id: string; kind: string; filename: string; stripped: number }[];
      for (const asset of assets) {
        const isPreviewDerivative = ["poster", "preview_audio", "preview_video"].includes(asset.kind);
        const isFullMedia = ["audio_overview", "video_overview"].includes(asset.kind);
        const included = !asset.stripped && !isPreviewDerivative && ids.has(asset.id) ? 1 : 0;
        const previewPolicy = isPreviewDerivative
          ? "public"
          : isFullMedia
            ? "derived_only"
            : included && asset.kind !== "subtitle" && isPreviewableArtifact(asset.kind, asset.filename)
              ? "public"
              : "none";
        db.prepare(`UPDATE listing_assets SET included = ? WHERE id = ?`).run(
          included,
          asset.id
        );
        db.prepare(`UPDATE listing_assets SET preview_policy = ? WHERE id = ?`).run(previewPolicy, asset.id);
      }
    }

    if (Array.isArray(body.tags)) {
      db.prepare(`DELETE FROM listing_tags WHERE listing_id = ?`).run(listingId);
      const tags = [
        ...new Set<string>(
          (body.tags as unknown[]).map((tag) => String(tag).trim()).filter(Boolean)
        )
      ].slice(0, 20);
      for (const tag of tags) {
        db.prepare(
          `INSERT OR IGNORE INTO listing_tags (listing_id, tag, topic_id) VALUES (?, ?, ?)`
        ).run(listingId, tag, body.topic_id ?? null);
      }
    }

    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'listing.update', 'listing', ?, ?, ?)`
    ).run(
      id("aud"),
      admin.id,
      listingId,
      JSON.stringify({ from_status: listing.status, status, price_tier: priceTier }),
      ts
    );
  });

  const next = db.prepare(`SELECT * FROM listings WHERE id = ?`).get(listingId);
  return c.json({ listing: next });
});

adminRoutes.post("/listings/:id/publish", async (c) => {
  const admin = requireAdmin(c);
  const listingId = c.req.param("id");
  const db = getDb();
  const listing = db.prepare(`SELECT * FROM listings WHERE id = ?`).get(listingId) as any;
  if (!listing) return c.json({ error: "not found" }, 404);
  if (!["draft", "unlisted", "published"].includes(listing.status)) {
    return c.json({ error: `invalid transition ${listing.status} -> published` }, 409);
  }
  const draftVersion = db
    .prepare(`SELECT id FROM listing_versions WHERE listing_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`)
    .get(listingId) as { id: string } | undefined;
  const usable = draftVersion
    ? (db.prepare(`SELECT COUNT(*) AS c FROM listing_assets WHERE version_id = ? AND stripped = 0 AND included = 1`)
        .get(draftVersion.id) as { c: number })
    : (db.prepare(`SELECT COUNT(*) AS c FROM listing_files WHERE listing_id = ? AND stripped = 0 AND included = 1`)
        .get(listingId) as { c: number });
  if (usable.c === 0) return c.json({ error: "无可用文件，无法发布" }, 400);
  const ts = nowIso();
  withTransaction(() => {
    if (draftVersion) {
      db.prepare(`UPDATE listing_versions SET status = 'superseded' WHERE listing_id = ? AND status = 'active'`).run(listingId);
      db.prepare(`UPDATE listing_versions SET status = 'active', activated_at = ? WHERE id = ?`).run(ts, draftVersion.id);
    }
    const draftCover = draftVersion
      ? (db.prepare(`SELECT cover_path FROM listing_versions WHERE id = ?`).get(draftVersion.id) as { cover_path: string | null } | undefined)?.cover_path ?? null
      : null;
    db.prepare(
      `UPDATE listings SET status = 'published', active_version_id = COALESCE(?, active_version_id),
       cover_path = COALESCE(?, cover_path),
       published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`
    ).run(draftVersion?.id ?? null, draftCover, ts, ts, listingId);
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'listing.publish', 'listing', ?, ?, ?)`
    ).run(id("aud"), admin.id, listingId, JSON.stringify({ from_status: listing.status, active_version_id: draftVersion?.id ?? null }), ts);
  });
  return c.json({ ok: true });
});

adminRoutes.post("/credits/grant", async (c) => {
  const admin = requireAdmin(c);
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email ?? "").toLowerCase();
  const amount = Number(body.amount ?? 0);
  if (!email || !Number.isFinite(amount) || amount === 0) {
    return c.json({ error: "email/amount invalid" }, 400);
  }
  const db = getDb();
  const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as
    | { id: string }
    | undefined;
  if (!user) return c.json({ error: "user not found" }, 404);
  const account = db
    .prepare(`SELECT balance FROM credit_accounts WHERE user_id = ?`)
    .get(user.id) as { balance: number };
  const next = account.balance + amount;
  if (next < 0) return c.json({ error: "余额将为负" }, 400);
  const ts = nowIso();
  withTransaction(() => {
    db.prepare(`UPDATE credit_accounts SET balance = ? WHERE user_id = ?`).run(next, user.id);
    db.prepare(
      `INSERT INTO ledger_entries (id, user_id, order_id, entry_type, amount, balance_after, note, created_at)
       VALUES (?, ?, NULL, 'grant', ?, ?, ?, ?)`
    ).run(id("led"), user.id, amount, next, String(body.note ?? "admin grant"), ts);
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'credits.grant', 'user', ?, ?, ?)`
    ).run(id("aud"), admin.id, user.id, JSON.stringify({ amount }), ts);
  });
  return c.json({ balance: next });
});

adminRoutes.get("/price-tiers", (c) => {
  return c.json({
    tiers: getDb().prepare(`SELECT id, label, credits FROM price_tiers ORDER BY credits`).all()
  });
});

adminRoutes.patch("/price-tiers/:id", async (c) => {
  const admin = requireAdmin(c);
  const tierId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const credits = Number(body.credits);
  const label = String(body.label ?? "").trim();
  if (!Number.isSafeInteger(credits) || credits < 0 || credits > 100000 || !label || label.length > 40) {
    return c.json({ error: "invalid tier" }, 400);
  }
  const db = getDb();
  const current = db.prepare(`SELECT id FROM price_tiers WHERE id = ?`).get(tierId);
  if (!current) return c.json({ error: "not found" }, 404);
  const ts = nowIso();
  withTransaction(() => {
    db.prepare(`UPDATE price_tiers SET label = ?, credits = ? WHERE id = ?`).run(label, credits, tierId);
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'price_tier.update', 'config', ?, ?, ?)`
    ).run(id("aud"), admin.id, tierId, JSON.stringify({ label, credits }), ts);
  });
  return c.json({ id: tierId, label, credits });
});

adminRoutes.get("/users", (c) => {
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.created_at,
              a.balance, a.pending_earnings, a.lifetime_spent, a.lifetime_earned,
              (SELECT COUNT(*) FROM orders o WHERE o.buyer_user_id = u.id) AS order_count
       FROM users u JOIN credit_accounts a ON a.user_id = u.id
       ORDER BY u.created_at DESC LIMIT 200`
    )
    .all();
  return c.json({ users: rows });
});

adminRoutes.get("/orders", (c) => {
  const rows = getDb()
    .prepare(
      `SELECT o.*, b.email AS buyer_email, l.title AS listing_title, a.email AS author_email
       FROM orders o
       JOIN users b ON b.id = o.buyer_user_id
       JOIN listings l ON l.id = o.listing_id
       JOIN users a ON a.id = l.author_user_id
       ORDER BY o.created_at DESC LIMIT 200`
    )
    .all();
  return c.json({ orders: rows });
});

adminRoutes.get("/audit-logs", (c) => {
  const action = String(c.req.query("action") ?? "").trim();
  const rows = action
    ? getDb()
        .prepare(
          `SELECT a.*, u.email AS actor_email FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_user_id
           WHERE a.action = ? ORDER BY a.created_at DESC LIMIT 200`
        )
        .all(action)
    : getDb()
        .prepare(
          `SELECT a.*, u.email AS actor_email FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_user_id
           ORDER BY a.created_at DESC LIMIT 200`
        )
        .all();
  return c.json({ logs: rows });
});

adminRoutes.get("/reports", (c) => {
  const status = String(c.req.query("status") ?? "open");
  if (!["open", "resolved", "dismissed", "all"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  const where = status === "all" ? "" : "WHERE r.status = ?";
  const rows = getDb()
    .prepare(
      `SELECT r.*, l.title AS listing_title, u.email AS reporter_email
       FROM reports r
       JOIN listings l ON l.id = r.listing_id
       JOIN users u ON u.id = r.reporter_user_id
       ${where}
       ORDER BY r.created_at DESC LIMIT 200`
    )
    .all(...(status === "all" ? [] : [status]));
  return c.json({ reports: rows });
});

adminRoutes.patch("/reports/:id", async (c) => {
  const admin = requireAdmin(c);
  const reportId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const status = String(body.status ?? "resolved");
  const resolution = String(body.resolution ?? "").trim().slice(0, 1000);
  const takeDown = body.take_down === true;
  if (!["resolved", "dismissed"].includes(status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  const db = getDb();
  const report = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(reportId) as any;
  if (!report) return c.json({ error: "not found" }, 404);
  if (report.status !== "open") return c.json({ error: "report already handled" }, 409);
  const ts = nowIso();
  withTransaction(() => {
    db.prepare(`UPDATE reports SET status = ?, resolution = ?, updated_at = ? WHERE id = ?`).run(
      status,
      resolution,
      ts,
      reportId
    );
    if (takeDown) {
      db.prepare(
        `UPDATE listings SET status = 'taken_down', updated_at = ?
         WHERE id = ? AND status IN ('published', 'unlisted')`
      ).run(ts, report.listing_id);
    }
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'report.resolve', 'report', ?, ?, ?)`
    ).run(
      id("aud"),
      admin.id,
      reportId,
      JSON.stringify({ status, take_down: takeDown, listing_id: report.listing_id, resolution }),
      ts
    );
  });
  return c.json({ id: reportId, status, take_down: takeDown });
});

adminRoutes.get("/revenue-share", (c) => {
  return c.json({
    configs: getDb()
      .prepare(
        `SELECT id, version, author_share_bps, platform_share_bps, effective_at
         FROM revenue_share_configs ORDER BY version DESC`
      )
      .all()
  });
});

adminRoutes.post("/revenue-share", async (c) => {
  const admin = requireAdmin(c);
  const body = await c.req.json().catch(() => ({}));
  const author = Number(body.author_share_bps ?? 7000);
  const platform = Number(body.platform_share_bps ?? 3000);
  if (
    !Number.isSafeInteger(author) ||
    !Number.isSafeInteger(platform) ||
    author < 0 ||
    platform < 0 ||
    author + platform !== 10000
  ) {
    return c.json({ error: "bps 必须为非负整数且之和为 10000" }, 400);
  }
  const db = getDb();
  const latest = db
    .prepare(`SELECT MAX(version) AS v FROM revenue_share_configs`)
    .get() as { v: number | null };
  const version = (latest.v ?? 0) + 1;
  const ts = nowIso();
  db.prepare(
    `INSERT INTO revenue_share_configs (id, version, author_share_bps, platform_share_bps, effective_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id("rsc"), version, author, platform, ts, ts);
  db.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, 'revenue_share.create', 'config', ?, ?, ?)`
  ).run(id("aud"), admin.id, String(version), JSON.stringify({ author, platform }), ts);
  return c.json({ version, author_share_bps: author, platform_share_bps: platform });
});

import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { config } from "../config.js";
import { getDb, id, nowIso, withTransaction } from "../db/client.js";

export type SyncPublishPolicy = "review" | "auto_publish";

export type AutoPublishGate = {
  ok: boolean;
  code?: string;
  message?: string;
  removedCount: number;
  coreCountBefore: number;
  coreCountAfter: number;
};

export type GateAsset = {
  upstream_asset_id: string;
  kind: string;
  stripped: number;
  included?: number;
};

const PREVIEW_KINDS = new Set(["poster", "preview_audio", "preview_video"]);

function safeEqual(expected: string, actual: string): boolean {
  if (!expected || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export function syncPolicy(value: unknown): SyncPublishPolicy {
  return value === "auto_publish" ? "auto_publish" : "review";
}

export function requireSyncClient(c: Context): { actorId: string; policy: SyncPublishPolicy } {
  if (!config.resourceGallerySyncEnabled) throw new Error("SYNC_DISABLED");
  if (!config.resourceGallerySyncToken) throw new Error("SYNC_NOT_CONFIGURED");
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!safeEqual(config.resourceGallerySyncToken, token)) throw new Error("SYNC_UNAUTHORIZED");
  if (!config.resourceGallerySyncActorEmail) throw new Error("SYNC_ACTOR_NOT_CONFIGURED");
  const actor = getDb().prepare(
    `SELECT id FROM users WHERE email = ? AND role = 'admin'`
  ).get(config.resourceGallerySyncActorEmail) as { id: string } | undefined;
  if (!actor) throw new Error("SYNC_ACTOR_NOT_FOUND");
  return {
    actorId: actor.id,
    policy: syncPolicy(c.req.header("x-resource-gallery-publish-policy"))
  };
}

export function startSyncRun(policy: SyncPublishPolicy, source = "video2ppt"): string {
  const runId = id("sync");
  getDb().prepare(
    `INSERT INTO resource_sync_runs (
      id, source, publish_policy, status, created_at
    ) VALUES (?, ?, ?, 'running', ?)`
  ).run(runId, source, policy, nowIso());
  return runId;
}

export function finishSyncRun(
  runId: string,
  result: {
    status: "succeeded" | "failed";
    scanned: number;
    changed: number;
    unchanged: number;
    imported: number;
    review: number;
    published: number;
    failed: number;
    message?: string;
  }
): void {
  getDb().prepare(
    `UPDATE resource_sync_runs
     SET status = ?, scanned_count = ?, changed_count = ?, unchanged_count = ?,
         imported_count = ?, review_count = ?, published_count = ?, failed_count = ?,
         message = ?, finished_at = ?
     WHERE id = ?`
  ).run(
    result.status,
    result.scanned,
    result.changed,
    result.unchanged,
    result.imported,
    result.review,
    result.published,
    result.failed,
    result.message ?? "",
    nowIso(),
    runId
  );
}

export function updateSyncState(input: {
  taskId: string;
  listingId?: string | null;
  versionId?: string | null;
  fingerprint?: string | null;
  packageSha?: string | null;
  policy: SyncPublishPolicy;
  status: "pending" | "running" | "review" | "published" | "failed";
  attemptCount?: number;
  errorCode?: string | null;
  errorMessage?: string;
  syncedAt?: string | null;
}): void {
  getDb().prepare(
    `INSERT INTO resource_sync_states (
      source_task_id, listing_id, listing_version_id, export_fingerprint, package_sha256,
      publish_policy, status, attempt_count, last_error_code, last_error_message,
      synced_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_task_id) DO UPDATE SET
      listing_id = excluded.listing_id,
      listing_version_id = excluded.listing_version_id,
      export_fingerprint = excluded.export_fingerprint,
      package_sha256 = excluded.package_sha256,
      publish_policy = excluded.publish_policy,
      status = excluded.status,
      attempt_count = excluded.attempt_count,
      last_error_code = excluded.last_error_code,
      last_error_message = excluded.last_error_message,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at`
  ).run(
    input.taskId,
    input.listingId ?? null,
    input.versionId ?? null,
    input.fingerprint ?? null,
    input.packageSha ?? null,
    input.policy,
    input.status,
    input.attemptCount ?? 1,
    input.errorCode ?? null,
    (input.errorMessage ?? "").slice(0, 1000),
    input.syncedAt ?? null,
    nowIso()
  );
}

export function evaluateAutoPublishGate(
  previousAssets: GateAsset[],
  nextAssets: GateAsset[],
  maxRemovedFiles: number
): AutoPublishGate {
  const usable = nextAssets.filter((asset) => !asset.stripped && asset.included);
  if (!usable.length) {
    return { ok: false, code: "NO_INCLUDED_ASSETS", message: "没有已纳入交付集合的安全资产", removedCount: 0, coreCountBefore: 0, coreCountAfter: 0 };
  }
  const nextIds = new Set(nextAssets.map((asset) => asset.upstream_asset_id));
  const removedCount = previousAssets.filter((asset) => !nextIds.has(asset.upstream_asset_id) && !asset.stripped).length;
  const coreBefore = previousAssets.filter((asset) => !asset.stripped && !PREVIEW_KINDS.has(asset.kind)).length;
  const coreAfter = nextAssets.filter((asset) => !asset.stripped && !PREVIEW_KINDS.has(asset.kind)).length;
  if (removedCount > maxRemovedFiles) {
    return { ok: false, code: "REMOVED_ASSETS_EXCEED_LIMIT", message: `自动发布会移除 ${removedCount} 个资产`, removedCount, coreCountBefore: coreBefore, coreCountAfter: coreAfter };
  }
  if (coreAfter < coreBefore) {
    return { ok: false, code: "CORE_ASSETS_DECREASED", message: `核心资产从 ${coreBefore} 个减少到 ${coreAfter} 个`, removedCount, coreCountBefore: coreBefore, coreCountAfter: coreAfter };
  }
  return { ok: true, removedCount, coreCountBefore: coreBefore, coreCountAfter: coreAfter };
}

function autoPublishGate(listingId: string): AutoPublishGate {
  const db = getDb();
  const listing = db.prepare(
    `SELECT status, active_version_id FROM listings WHERE id = ?`
  ).get(listingId) as { status: string; active_version_id: string | null } | undefined;
  if (!listing) return { ok: false, code: "LISTING_NOT_FOUND", message: "Listing 不存在", removedCount: 0, coreCountBefore: 0, coreCountAfter: 0 };
  if (listing.status === "taken_down") {
    return { ok: false, code: "LISTING_TAKEN_DOWN", message: "已下架 Listing 不允许自动发布", removedCount: 0, coreCountBefore: 0, coreCountAfter: 0 };
  }
  const draft = db.prepare(
    `SELECT id FROM listing_versions WHERE listing_id = ? AND status = 'draft'
     ORDER BY created_at DESC LIMIT 1`
  ).get(listingId) as { id: string } | undefined;
  if (!draft) return { ok: false, code: "NO_DRAFT_VERSION", message: "没有可发布的草稿版本", removedCount: 0, coreCountBefore: 0, coreCountAfter: 0 };
  const nextAssets = db.prepare(
    `SELECT upstream_asset_id, kind, stripped, included FROM listing_assets WHERE version_id = ?`
  ).all(draft.id) as GateAsset[];
  const previousAssets = listing.active_version_id
    ? db.prepare(`SELECT upstream_asset_id, kind, stripped FROM listing_assets WHERE version_id = ?`).all(listing.active_version_id) as { upstream_asset_id: string; kind: string; stripped: number }[]
    : [];
  return evaluateAutoPublishGate(previousAssets, nextAssets, config.resourceGallerySyncMaxRemovedFiles);
}

export function autoPublishListing(listingId: string, actorId: string): AutoPublishGate {
  const gate = autoPublishGate(listingId);
  if (!gate.ok) return gate;
  const db = getDb();
  const ts = nowIso();
  const draft = db.prepare(
    `SELECT id, cover_path FROM listing_versions WHERE listing_id = ? AND status = 'draft'
     ORDER BY created_at DESC LIMIT 1`
  ).get(listingId) as { id: string; cover_path: string | null } | undefined;
  if (!draft) return { ...gate, ok: false, code: "NO_DRAFT_VERSION", message: "没有可发布的草稿版本" };
  withTransaction(() => {
    db.prepare(`UPDATE listing_versions SET status = 'superseded' WHERE listing_id = ? AND status = 'active'`).run(listingId);
    db.prepare(`UPDATE listing_versions SET status = 'active', activated_at = ? WHERE id = ?`).run(ts, draft.id);
    db.prepare(
      `UPDATE listings SET status = 'published', active_version_id = ?, cover_path = COALESCE(?, cover_path),
       published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`
    ).run(draft.id, draft.cover_path, ts, ts, listingId);
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'sync.auto_publish', 'listing', ?, ?, ?)`
    ).run(id("aud"), actorId, listingId, JSON.stringify({ version_id: draft.id, ...gate }), ts);
  });
  return gate;
}

export function parseSyncError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const [code, ...rest] = message.split(":");
  return {
    code: /^[A-Z][A-Z0-9_]+$/.test(code) ? code : "SYNC_IMPORT_FAILED",
    message: (rest.length ? rest.join(":") : message).slice(0, 1000)
  };
}

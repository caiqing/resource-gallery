import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

let db: DatabaseSync | null = null;

function ensureListingSummaryColumns(database: DatabaseSync): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(listings)").all() as { name: string }[]).map(
      (column) => column.name
    )
  );
  const additions = [
    ["summary_status", "TEXT NOT NULL DEFAULT 'ready'"],
    ["summary_origin", "TEXT NOT NULL DEFAULT 'fallback'"],
    ["summary_source_hash", "TEXT"],
    ["summary_model", "TEXT"],
    ["summary_generated_at", "TEXT"],
    ["summary_locked", "INTEGER NOT NULL DEFAULT 0"],
    ["tag_status", "TEXT NOT NULL DEFAULT 'ready'"],
    ["tag_origin", "TEXT NOT NULL DEFAULT 'fallback'"],
    ["tag_source_hash", "TEXT"],
    ["tag_model", "TEXT"],
    ["tag_generated_at", "TEXT"],
    ["tag_locked", "INTEGER NOT NULL DEFAULT 0"]
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE listings ADD COLUMN ${name} ${definition}`);
  }
}

function ensureListingVersionColumns(database: DatabaseSync): void {
  const listingColumns = new Set(
    (database.prepare("PRAGMA table_info(listings)").all() as { name: string }[]).map(
      (column) => column.name
    )
  );
  if (!listingColumns.has("active_version_id")) {
    database.exec("ALTER TABLE listings ADD COLUMN active_version_id TEXT");
  }
  const versionColumns = new Set(
    (database.prepare("PRAGMA table_info(listing_versions)").all() as { name: string }[]).map(
      (column) => column.name
    )
  );
  if (!versionColumns.has("cover_path")) {
    database.exec("ALTER TABLE listing_versions ADD COLUMN cover_path TEXT");
  }
  const assetColumns = new Set(
    (database.prepare("PRAGMA table_info(listing_assets)").all() as { name: string }[]).map(
      (column) => column.name
    )
  );
  if (!assetColumns.has("variant_group_id")) {
    database.exec("ALTER TABLE listing_assets ADD COLUMN variant_group_id TEXT");
  }
}

function legacyVersionId(listingId: string): string {
  return `legacy_${createHash("sha256").update(listingId).digest("hex").slice(0, 24)}`;
}

function legacyAssetMustStrip(kind: string, filename: string): boolean {
  if (["video", "subtitle", "auth"].includes(kind)) return true;
  return /(cookie|cookies|auth|credential|token|secret|\.env)/i.test(filename);
}

export function backfillLegacyListingVersions(database: DatabaseSync): void {
  // Legacy listing_files are v1 data. Re-apply the v1 safety boundary on every
  // startup so records created before the versioned importer cannot remain public.
  database.exec(`
    UPDATE listing_files
    SET stripped = 1, included = 0, is_previewable = 0
    WHERE kind IN ('video', 'subtitle', 'auth')
       OR lower(filename) LIKE '%cookie%'
       OR lower(filename) LIKE '%auth%'
       OR lower(filename) LIKE '%credential%'
       OR lower(filename) LIKE '%token%'
       OR lower(filename) LIKE '%secret%'
       OR lower(filename) LIKE '%.env%'
  `);
  database.exec(`
    UPDATE listing_assets
    SET stripped = 1, included = 0, preview_policy = 'none'
    WHERE version_id IN (SELECT id FROM listing_versions WHERE schema_version = 'resource-gallery.export/v1')
      AND (
        kind IN ('video', 'subtitle', 'auth')
        OR lower(filename) LIKE '%cookie%'
        OR lower(filename) LIKE '%auth%'
        OR lower(filename) LIKE '%credential%'
        OR lower(filename) LIKE '%token%'
        OR lower(filename) LIKE '%secret%'
        OR lower(filename) LIKE '%.env%'
      )
  `);
  const listings = database
    .prepare(`SELECT id FROM listings WHERE active_version_id IS NULL`)
    .all() as { id: string }[];
  for (const listing of listings) {
    const files = database
      .prepare(`SELECT id, kind, filename, storage_path, size_bytes, sha256, included, stripped, is_previewable
                FROM listing_files WHERE listing_id = ? ORDER BY filename`)
      .all(listing.id) as {
        id: string;
        kind: string;
        filename: string;
        storage_path: string;
        size_bytes: number;
        sha256: string;
        included: number;
        stripped: number;
        is_previewable: number;
      }[];
    if (!files.length) continue;
    const versionId = legacyVersionId(listing.id);
    const packageSha = createHash("sha256")
      .update(JSON.stringify(files.map((file) => [file.id, file.sha256, file.size_bytes])))
      .digest("hex");
    const ts = new Date().toISOString();
    database.exec("BEGIN");
    try {
      database.prepare(
        `INSERT OR IGNORE INTO listing_versions (
          id, listing_id, schema_version, package_sha256, export_fingerprint, status,
          source_run_id, source_run_index, created_at, activated_at
        ) VALUES (?, ?, 'resource-gallery.export/v1', ?, ?, 'active', NULL, NULL, ?, ?)`
      ).run(versionId, listing.id, packageSha, packageSha, ts, ts);
      for (const file of files) {
        const stripped = file.stripped || legacyAssetMustStrip(file.kind, file.filename);
        const included = stripped ? 0 : file.included;
        const previewPolicy = included && file.is_previewable ? "public" : "none";
        database.prepare(
          `INSERT OR IGNORE INTO listing_assets (
            id, version_id, upstream_asset_id, variant_group_id, parent_asset_id, kind, filename, storage_path, size_bytes, sha256,
            mime_type, duration_ms, width, height, audio_codec, video_codec, language, provenance,
            preview_policy, entitlement_download, included, stripped, source_run_id
          ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pipeline', ?, 0, ?, ?, NULL)`
        ).run(
          file.id, versionId, file.id, file.kind, file.filename, file.storage_path,
          file.size_bytes, file.sha256, previewPolicy, included ? 1 : 0, stripped ? 1 : 0
        );
      }
      database.prepare(`UPDATE listings SET active_version_id = ? WHERE id = ? AND active_version_id IS NULL`)
        .run(versionId, listing.id);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(config.databasePath), { recursive: true });
  mkdirSync(config.blobRoot, { recursive: true });
  mkdirSync(config.uploadRoot, { recursive: true });
  db = new DatabaseSync(config.databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  const schema = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "schema.sql"),
    "utf8"
  );
  db.exec(schema);
  ensureListingSummaryColumns(db);
  ensureListingVersionColumns(db);
  backfillLegacyListingVersions(db);
  return db;
}

export function withTransaction<T>(fn: () => T): T {
  const database = getDb();
  database.exec("BEGIN");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

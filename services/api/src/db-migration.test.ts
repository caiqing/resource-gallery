import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

process.env.SESSION_SECRET ??= "migration-test-session-secret-012345678901234567890123";
process.env.DOWNLOAD_SIGNING_SECRET ??= "migration-test-download-secret-012345678901234567890123";
const { backfillLegacyListingVersions } = await import("./db/client.js");

const path = join(process.cwd(), "data", `legacy-migration-${process.pid}.db`);
const db = new DatabaseSync(path);
db.exec(readFileSync(join(process.cwd(), "src/db/schema.sql"), "utf8"));

after(() => {
  db.close();
  rmSync(path, { force: true });
});

describe("legacy listing version migration", () => {
  it("backfills legacy files idempotently and preserves storage paths", () => {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, role, created_at)
       VALUES ('u_legacy', 'legacy@example.test', 'hash', 'Legacy', 'admin', '2026-08-05T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO listings (id, title, author_user_id, status, created_at, updated_at)
       VALUES ('lst_legacy', 'Legacy', 'u_legacy', 'published', '2026-08-05T00:00:00Z', '2026-08-05T00:00:00Z')`
    ).run();
    db.prepare(
      `INSERT INTO listing_files (id, listing_id, kind, filename, storage_path, size_bytes, sha256, is_previewable, included, stripped)
       VALUES ('file_legacy', 'lst_legacy', 'content', 'legacy.md', 'legacy.md', 3, 'abc', 1, 1, 0)`
    ).run();
    db.prepare(
      `INSERT INTO listing_files (id, listing_id, kind, filename, storage_path, size_bytes, sha256, is_previewable, included, stripped)
       VALUES ('file_source_video', 'lst_legacy', 'video', 'source.mp4', 'source.mp4', 4, 'def', 1, 1, 0)`
    ).run();

    backfillLegacyListingVersions(db);
    backfillLegacyListingVersions(db);

    const listing = db.prepare(`SELECT active_version_id FROM listings WHERE id = 'lst_legacy'`).get() as { active_version_id: string };
    assert.ok(listing.active_version_id);
    const versionCount = db.prepare(`SELECT COUNT(*) AS count FROM listing_versions WHERE listing_id = 'lst_legacy'`).get() as { count: number };
    assert.equal(versionCount.count, 1);
    const asset = db.prepare(`SELECT storage_path, preview_policy, included FROM listing_assets WHERE version_id = ? AND filename = 'legacy.md'`).get(listing.active_version_id) as { storage_path: string; preview_policy: string; included: number };
    assert.deepEqual({ ...asset }, { storage_path: "legacy.md", preview_policy: "public", included: 1 });
    const stripped = db.prepare(`SELECT stripped, included, preview_policy FROM listing_assets WHERE version_id = ? AND filename = 'source.mp4'`).get(listing.active_version_id) as { stripped: number; included: number; preview_policy: string };
    assert.deepEqual({ ...stripped }, { stripped: 1, included: 0, preview_policy: "none" });

    // Also repair a legacy v1 asset that was already backfilled by an older build.
    db.prepare(`UPDATE listing_assets SET stripped = 0, included = 1, preview_policy = 'public' WHERE version_id = ? AND filename = 'source.mp4'`).run(listing.active_version_id);
    backfillLegacyListingVersions(db);
    const repaired = db.prepare(`SELECT stripped, included, preview_policy FROM listing_assets WHERE version_id = ? AND filename = 'source.mp4'`).get(listing.active_version_id) as { stripped: number; included: number; preview_policy: string };
    assert.deepEqual({ ...repaired }, { stripped: 1, included: 0, preview_policy: "none" });
  });
});

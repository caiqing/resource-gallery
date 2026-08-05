import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { config } from "../config.js";
import { getDb, nowIso } from "../db/client.js";
import {
  generateListingSummary,
  isSummaryTextFile,
  type SummarySourceFile
} from "./summary.js";
import { summaryLlmConfigured, summaryLlmOptions } from "./llm-settings.js";

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

function safeBlobPath(listingId: string, storagePath: string): string | null {
  const root = resolve(config.blobRoot, listingId);
  const target = resolve(root, storagePath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
}

export async function listingSources(listingId: string): Promise<SummarySourceFile[]> {
  const rows = getDb()
    .prepare(
      `SELECT kind, filename, storage_path, sha256, size_bytes
       FROM listing_files
       WHERE listing_id = ? AND stripped = 0 AND storage_path <> ''
       ORDER BY filename`
    )
    .all(listingId) as {
      kind: string;
      filename: string;
      storage_path: string;
      sha256: string;
      size_bytes: number;
    }[];
  const sources: SummarySourceFile[] = [];
  for (const row of rows) {
    if (!isSummaryTextFile(row.kind, row.filename) || row.size_bytes > MAX_TEXT_FILE_BYTES) continue;
    const path = safeBlobPath(listingId, row.storage_path);
    if (!path) continue;
    try {
      sources.push({
        kind: row.kind,
        name: row.filename,
        sha256: row.sha256,
        content: await readFile(path, "utf8")
      });
    } catch {
      // One missing historical file must not block compensation for other listings.
    }
  }
  return sources;
}

async function backfillOne(
  listing: { id: string; title: string },
  upgradeFallback: boolean,
  forceFallback: boolean
): Promise<boolean> {
  const db = getDb();
  db.prepare(
    `UPDATE listings SET summary_status = 'generating'
     WHERE id = ? AND summary_locked = 0 AND summary_origin <> 'operator'
       AND (
         TRIM(summary) = '' OR TRIM(summary) = TRIM(title) OR summary_status = 'failed'
         OR (? = 1 AND summary_origin = 'fallback' AND summary_model IS NULL)
         OR (? = 1 AND summary_origin = 'fallback')
       )`
  ).run(listing.id, upgradeFallback ? 1 : 0, forceFallback ? 1 : 0);
  const result = await generateListingSummary({
    title: listing.title,
    files: await listingSources(listing.id),
    llm: summaryLlmOptions()
  });
  const updated = db.prepare(
    `UPDATE listings SET
       summary = ?, summary_status = ?, summary_origin = ?, summary_source_hash = ?,
       summary_model = ?, summary_generated_at = ?, updated_at = ?
     WHERE id = ? AND summary_locked = 0 AND summary_origin <> 'operator'
       AND (
         TRIM(summary) = '' OR TRIM(summary) = TRIM(title) OR summary_status IN ('failed', 'generating')
         OR (? = 1 AND summary_origin = 'fallback' AND summary_model IS NULL)
         OR (? = 1 AND summary_origin = 'fallback')
       )`
  ).run(
    result.summary,
    result.status,
    result.origin,
    result.sourceHash,
    result.model,
    result.generatedAt,
    nowIso(),
    listing.id,
    upgradeFallback ? 1 : 0,
    forceFallback ? 1 : 0
  );
  return Number(updated.changes) > 0;
}

export async function backfillMissingListingSummaries(
  limit = 100,
  options: { forceFallback?: boolean } = {}
): Promise<{
  scanned: number;
  updated: number;
}> {
  const upgradeFallback = summaryLlmConfigured();
  const forceFallback = options.forceFallback === true;
  const listings = getDb()
    .prepare(
      `SELECT id, title FROM listings
       WHERE summary_locked = 0 AND summary_origin <> 'operator'
         AND (
           TRIM(summary) = '' OR TRIM(summary) = TRIM(title) OR summary_status = 'failed'
           OR (? = 1 AND summary_origin = 'fallback' AND summary_model IS NULL)
           OR (? = 1 AND summary_origin = 'fallback')
         )
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .all(
      upgradeFallback ? 1 : 0,
      forceFallback ? 1 : 0,
      Math.max(1, Math.min(limit, 500))
    ) as {
      id: string;
      title: string;
    }[];
  let updated = 0;
  for (let index = 0; index < listings.length; index += 3) {
    const results = await Promise.all(
      listings
        .slice(index, index + 3)
        .map((listing) => backfillOne(listing, upgradeFallback, forceFallback))
    );
    updated += results.filter(Boolean).length;
  }
  return { scanned: listings.length, updated };
}

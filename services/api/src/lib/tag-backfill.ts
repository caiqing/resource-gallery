import { getDb, nowIso } from "../db/client.js";
import { generateListingTags } from "./tags.js";
import { summaryLlmOptions } from "./llm-settings.js";
import { listingSources } from "./summary-backfill.js";

export async function backfillListingTags(limit = 500): Promise<{ scanned: number; updated: number }> {
  const db = getDb();
  const listings = db.prepare(
    `SELECT id, title, summary FROM listings
     WHERE tag_locked = 0
     ORDER BY updated_at ASC
     LIMIT ?`
  ).all(Math.max(1, Math.min(limit, 500))) as { id: string; title: string; summary: string }[];
  let updated = 0;
  for (const listing of listings) {
    const result = await generateListingTags({
      title: listing.title,
      summary: listing.summary,
      files: await listingSources(listing.id),
      llm: summaryLlmOptions()
    });
    db.prepare(`DELETE FROM listing_tags WHERE listing_id = ?`).run(listing.id);
    for (const tag of result.tags) {
      db.prepare(
        `INSERT OR IGNORE INTO listing_tags (listing_id, tag, topic_id) VALUES (?, ?, ?)`
      ).run(listing.id, tag, result.topicId);
    }
    db.prepare(
      `UPDATE listings SET tag_status = 'ready', tag_origin = ?, tag_source_hash = ?,
       tag_model = ?, tag_generated_at = ?, updated_at = ?
       WHERE id = ? AND tag_locked = 0`
    ).run(result.origin, result.sourceHash, result.model, result.generatedAt, nowIso(), listing.id);
    updated += 1;
  }
  return { scanned: listings.length, updated };
}

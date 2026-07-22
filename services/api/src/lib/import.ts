import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  openZipEntries,
  validateExportPackage,
  type ValidatedFile
} from "@resource-gallery/export-schema";
import { config } from "../config.js";
import { getDb, id, nowIso, withTransaction } from "../db/client.js";
import { inferTopicAndTags } from "./tags.js";
import { sha256 } from "./crypto.js";

export async function processImportJob(jobId: string, zipPath: string): Promise<void> {
  const db = getDb();
  const job = db.prepare("SELECT * FROM import_jobs WHERE id = ?").get(jobId) as
    | { id: string; admin_user_id: string; filename: string }
    | undefined;
  if (!job) return;

  db.prepare(
    "UPDATE import_jobs SET status = 'processing', message = ? WHERE id = ?"
  ).run("validating", jobId);

  const result = await validateExportPackage(zipPath, {
    maxPackageBytes: config.maxPackageBytes
  });

  if (!result.ok || !result.manifest || !result.taskMeta || !result.runMeta) {
    const message = result.issues.map((i) => i.message).join("; ").slice(0, 1000);
    const ts = nowIso();
    db.prepare(
      "UPDATE import_jobs SET status = 'failed', message = ?, finished_at = ? WHERE id = ?"
    ).run(message, ts, jobId);
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'import.failed', 'import_job', ?, ?, ?)`
    ).run(id("aud"), job.admin_user_id, jobId, JSON.stringify({ message }), ts);
    return;
  }

  const manifest = result.manifest;
  const taskMeta = result.taskMeta;
  const runMeta = result.runMeta;
  const entries = await openZipEntries(zipPath);

  // Resource Gallery manages one resource per Video2PPT task. Pipeline runs are
  // retained only as provenance and must not create duplicate listings.
  const existing = db
    .prepare(
      `SELECT id, status FROM listings
       WHERE source_task_id = ?`
    )
    .get(manifest.task_id) as { id: string; status: string } | undefined;

  if (existing && existing.status === "published") {
    const ts = nowIso();
    const message = "该任务已存在已发布 Listing；请先下架后再更新任务产物";
    db.prepare(
      "UPDATE import_jobs SET status = 'failed', message = ?, finished_at = ?, source_task_id = ?, source_run_id = ? WHERE id = ?"
    ).run(
      message,
      ts,
      manifest.task_id,
      manifest.run_id,
      jobId
    );
    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'import.failed', 'import_job', ?, ?, ?)`
    ).run(
      id("aud"),
      job.admin_user_id,
      jobId,
      JSON.stringify({ message, listing_id: existing.id }),
      ts
    );
    return;
  }

  const listingId = existing?.id ?? id("lst");
  const listingDir = join(config.blobRoot, listingId);
  const stagingDir = join(config.blobRoot, `.import-${jobId}`);
  const backupDir = join(config.blobRoot, `.backup-${jobId}`);
  rmSync(stagingDir, { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const writeKept = (f: ValidatedFile) => {
    const buf = entries.get(f.path);
    if (!buf) throw new Error(`missing ${f.path}`);
    const destName = f.path.replace(/^files\//, "");
    const dest = join(stagingDir, destName);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, buf);
    return destName;
  };

  const stored = result.keptFiles.map((f) => {
    const storageRel = writeKept(f);
    return { ...f, storageRel };
  });

  // cover
  let coverPath: string | null = null;
  const coverBuf = entries.get("preview/cover.png");
  if (coverBuf) {
    writeFileSync(join(stagingDir, "cover.png"), coverBuf);
    coverPath = "cover.png";
  } else {
    const image = stored.find((file) =>
      [".png", ".jpg", ".jpeg", ".webp"].includes(extname(file.storageRel).toLowerCase())
    );
    coverPath = image?.storageRel ?? null;
  }

  const inferred = inferTopicAndTags({
    title: manifest.title,
    summary: taskMeta.title,
    filenames: stored.map((f) => f.name)
  });

  const tier = db.prepare("SELECT * FROM price_tiers WHERE id = 'standard'").get() as
    | { id: string; credits: number }
    | undefined;
  const priceCredits = tier?.credits ?? 12;
  const ts = nowIso();

  const hadPreviousBlob = existsSync(listingDir);
  if (hadPreviousBlob) renameSync(listingDir, backupDir);
  renameSync(stagingDir, listingDir);

  try {
    withTransaction(() => {
    if (existing) {
      db.prepare("DELETE FROM listing_files WHERE listing_id = ?").run(listingId);
      db.prepare("DELETE FROM listing_tags WHERE listing_id = ?").run(listingId);
      db.prepare(
        `UPDATE listings SET
          title = ?, summary = ?, cover_path = ?, source_run_id = ?, source_run_index = ?,
          price_tier = 'standard', price_credits = ?, status = 'draft',
          updated_at = ?
         WHERE id = ?`
      ).run(
        manifest.title,
        taskMeta.title,
        coverPath,
        manifest.run_id,
        manifest.run_index,
        priceCredits,
        ts,
        listingId
      );
    } else {
      db.prepare(
        `INSERT INTO listings (
          id, title, summary, cover_path, author_user_id,
          source_task_id, source_run_id, source_run_index,
          price_tier, price_credits, status, like_count, download_count,
          created_at, published_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'standard', ?, 'draft', 0, 0, ?, NULL, ?)`
      ).run(
        listingId,
        manifest.title,
        taskMeta.title,
        coverPath,
        job.admin_user_id,
        manifest.task_id,
        manifest.run_id,
        manifest.run_index,
        priceCredits,
        ts,
        ts
      );
    }

    for (const f of stored) {
      db.prepare(
        `INSERT INTO listing_files (
          id, listing_id, kind, filename, storage_path, size_bytes, sha256,
          is_previewable, included, stripped
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
      ).run(
        id("file"),
        listingId,
        f.kind,
        f.name,
        f.storageRel,
        f.size_bytes,
        f.sha256,
        f.kind === "infographic" || f.kind === "content" || f.kind === "slide_pdf" ? 1 : 0
      );
    }

    for (const f of result.strippedFiles) {
      db.prepare(
        `INSERT INTO listing_files (
          id, listing_id, kind, filename, storage_path, size_bytes, sha256,
          is_previewable, included, stripped
        ) VALUES (?, ?, ?, ?, '', ?, ?, 0, 0, 1)`
      ).run(id("file"), listingId, f.kind, f.name, f.size_bytes, f.sha256);
    }

    const tags = inferred.confidence === "low" ? ["待确认"] : inferred.tags;
    for (const tag of tags) {
      db.prepare(
        `INSERT OR IGNORE INTO listing_tags (listing_id, tag, topic_id) VALUES (?, ?, ?)`
      ).run(listingId, tag, inferred.topicId);
    }

    db.prepare(
      `UPDATE import_jobs
       SET status = 'succeeded', message = ?, listing_id = ?, source_task_id = ?, source_run_id = ?, finished_at = ?
       WHERE id = ?`
    ).run(
      `任务资源草稿已生成；剥离 ${result.strippedFiles.length} 个危险文件`,
      listingId,
      manifest.task_id,
      manifest.run_id,
      nowIso(),
      jobId
    );

    db.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, 'import.succeeded', 'listing', ?, ?, ?)`
    ).run(
      id("aud"),
      job.admin_user_id,
      listingId,
      JSON.stringify({
        stripped: result.strippedFiles.map((f) => f.path),
        task_id: manifest.task_id,
        run_id: manifest.run_id
      }),
      nowIso()
    );
    });
    rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    rmSync(listingDir, { recursive: true, force: true });
    if (hadPreviousBlob && existsSync(backupDir)) renameSync(backupDir, listingDir);
    throw error;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }
}

export function packageShaPlaceholder(zipPath: string): string {
  return sha256(readFileSync(zipPath));
}

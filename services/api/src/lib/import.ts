import { createReadStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  isDangerousKind,
  readV1PackageMetadata,
  readV2PackageMetadata,
  streamZipEntryToFile,
  type ExportManifestV2,
  type ManifestAsset,
  type PackageMetadataResult,
  type ValidatedFile
} from "@resource-gallery/export-schema";
import { config } from "../config.js";
import { getDb, id, nowIso, withTransaction } from "../db/client.js";
import { generateListingTags, tagSourceHash, type ListingTagResult } from "./tags.js";
import { sha256 } from "./crypto.js";
import {
  generateListingSummary,
  isSummaryTextFile,
  summarySourceHash,
  type ListingSummaryResult,
  type SummarySourceFile
} from "./summary.js";
import { summaryLlmConfigured, summaryLlmOptions } from "./llm-settings.js";
import { blobStore, type PromotedDirectory } from "./blob-store.js";

const PREVIEWABLE_KINDS = new Set([
  "infographic",
  "slide_pdf",
  "content",
  "blueprint",
  "prompt",
  "source_context",
  "video",
  "subtitle"
]);

export function isPreviewableArtifact(kind: string, filename = ""): boolean {
  if (PREVIEWABLE_KINDS.has(String(kind || ""))) return true;
  return /\.(md|markdown|mdx|txt)$/i.test(String(filename || ""));
}

function importFailure(job: { id: string; admin_user_id: string }, message: string): void {
  const ts = nowIso();
  const db = getDb();
  db.prepare("UPDATE import_jobs SET status = 'failed', message = ?, finished_at = ? WHERE id = ?")
    .run(message.slice(0, 1000), ts, job.id);
  db.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
     VALUES (?, ?, 'import.failed', 'import_job', ?, ?, ?)`
  ).run(id("aud"), job.admin_user_id, job.id, JSON.stringify({ message }), ts);
}

function metadataFailureMessage(metadata: PackageMetadataResult, fallback: string): string {
  const issues = metadata.issues
    .map((issue) => `${issue.code}: ${issue.message}`)
    .join("; ");
  return issues || fallback;
}

export type ImportOptions = {
  /** Machine sync binds its task header to the untrusted package manifest. */
  expectedTaskId?: string;
};

function rejectUnexpectedTaskId(
  job: { id: string; admin_user_id: string },
  expectedTaskId: string | undefined,
  actualTaskId: string
): boolean {
  if (!expectedTaskId || expectedTaskId === actualTaskId) return false;
  importFailure(
    job,
    `SYNC_TASK_ID_MISMATCH: 同步任务 ID 与导出包 task_id 不一致 (${expectedTaskId} != ${actualTaskId})`
  );
  return true;
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function exportFingerprint(manifest: ExportManifestV2): string {
  const normalized = Object.fromEntries(
    Object.entries(manifest)
      .filter(([key]) => key !== "exported_at" && key !== "package_sha256")
  ) as Record<string, unknown>;
  normalized.assets = [...manifest.assets]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((asset) => ({ ...asset }));
  return sha256(canonicalJson(normalized));
}

function probeImportedMedia(path: string, asset: ManifestAsset): void {
  const isAudio = asset.kind === "audio_overview" || asset.kind === "preview_audio";
  const isVideo = asset.kind === "video_overview" || asset.kind === "preview_video";
  const isPoster = asset.kind === "poster";
  if (!isAudio && !isVideo && !isPoster) return;
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { encoding: "utf8", timeout: 30_000 }
  );
  if (result.error || result.status !== 0) throw new Error(`MEDIA_PROBE_FAILED:${asset.name}`);
  let payload: any;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`MEDIA_METADATA_INVALID:${asset.name}`);
  }
  const durationMs = Math.round(Number(payload?.format?.duration) * 1000);
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const audio = streams.find((stream: any) => stream.codec_type === "audio");
  const video = streams.find((stream: any) => stream.codec_type === "video");
  const suffix = path.slice(path.lastIndexOf(".")).toLowerCase();

  if (isPoster) {
    const expectedCodecs: Record<string, string[]> = {
      ".png": ["png"],
      ".jpg": ["mjpeg"],
      ".jpeg": ["mjpeg"],
      ".webp": ["webp"]
    };
    if (!video || !expectedCodecs[suffix]?.includes(String(video.codec_name ?? "")) || Number(video.width) <= 0 || Number(video.height) <= 0) {
      throw new Error(`POSTER_METADATA_INVALID:${asset.name}`);
    }
    return;
  }

  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 2 * 60 * 60 * 1000) {
    throw new Error(`MEDIA_DURATION_INVALID:${asset.name}`);
  }
  if (!audio || !asset.media) {
    throw new Error(`MEDIA_METADATA_INVALID:${asset.name}`);
  }
  if (isAudio && (suffix !== ".m4a" && suffix !== ".mp4")) {
    throw new Error(`MEDIA_MIME_INVALID:${asset.name}`);
  }
  if (isVideo && (suffix !== ".mp4" && suffix !== ".webm")) {
    throw new Error(`MEDIA_MIME_INVALID:${asset.name}`);
  }
  const audioCodec = String(audio.codec_name ?? "");
  const videoCodec = String(video?.codec_name ?? "");
  if (isAudio && audioCodec !== "aac") {
    throw new Error(`MEDIA_CODEC_INVALID:${asset.name}`);
  }
  if (isVideo && (!video || Number(video.width) <= 0 || Number(video.height) <= 0)) {
    throw new Error(`MEDIA_METADATA_INVALID:${asset.name}`);
  }
  if (isVideo) {
    const isSupportedMp4 = suffix === ".mp4" && audioCodec === "aac" && videoCodec === "h264";
    const isSupportedWebm = suffix === ".webm" && ["opus", "vorbis"].includes(audioCodec) && ["vp8", "vp9", "av1"].includes(videoCodec);
    if (!isSupportedMp4 && !isSupportedWebm) throw new Error(`MEDIA_CODEC_INVALID:${asset.name}`);
  }
  const expectedMime = isAudio ? "audio/mp4" : suffix === ".mp4" ? "video/mp4" : "video/webm";
  if (asset.media.mime_type !== expectedMime || asset.media.duration_ms !== durationMs || asset.media.audio_codec !== audioCodec) {
    throw new Error(`MEDIA_METADATA_MISMATCH:${asset.name}`);
  }
  if (
    isVideo &&
    (asset.media.video_codec !== videoCodec ||
      asset.media.width !== Number(video.width) ||
      asset.media.height !== Number(video.height))
  ) {
    throw new Error(`MEDIA_METADATA_MISMATCH:${asset.name}`);
  }
}

async function processV2ImportJob(
  job: { id: string; admin_user_id: string; filename: string },
  zipPath: string,
  metadata: PackageMetadataResult
): Promise<void> {
  if (!metadata.ok || !metadata.manifest || !metadata.taskMeta || !metadata.runMeta || metadata.manifest.schema_version !== "resource-gallery.export/v2") {
    importFailure(job, metadataFailureMessage(metadata, "v2 包校验失败"));
    return;
  }
  const manifest: ExportManifestV2 = metadata.manifest;
  const db = getDb();
  const existing = db.prepare("SELECT id, title, status, active_version_id FROM listings WHERE source_task_id = ?")
    .get(manifest.task_id) as { id: string; title: string; status: string; active_version_id: string | null } | undefined;
  const listingId = existing?.id ?? id("lst");
  const packageSha = await sha256File(zipPath);
  const exportFingerprintValue = exportFingerprint(manifest);
  const duplicate = existing
    ? db.prepare("SELECT id FROM listing_versions WHERE listing_id = ? AND export_fingerprint = ?")
      .get(existing.id, exportFingerprintValue) as { id: string } | undefined
    : undefined;
  if (duplicate) {
    db.prepare(
      `UPDATE import_jobs SET status = 'succeeded', message = ?, listing_id = ?, source_task_id = ?, source_run_id = ?, finished_at = ? WHERE id = ?`
    ).run("v2 包已导入，复用已有草稿版本", listingId, manifest.task_id, manifest.run_id, nowIso(), job.id);
    return;
  }

  const versionId = id("ver");
  const stagingDir = join(config.blobRoot, `.import-${job.id}-${versionId}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  const stagedAssets: Array<{ asset: ManifestAsset; storagePath: string }> = [];
  let promoted: PromotedDirectory | undefined;
  try {
    for (const asset of manifest.assets) {
      const mediaLimit = asset.kind === "audio_overview"
        ? config.maxAudioOverviewBytes
        : asset.kind === "video_overview"
          ? config.maxVideoOverviewBytes
          : ["poster", "preview_audio", "preview_video"].includes(asset.kind)
            ? config.maxPreviewBytes
          : config.maxPackageBytes;
      if (asset.size_bytes > mediaLimit) {
        const errorCode = ["poster", "preview_audio", "preview_video"].includes(asset.kind)
          ? "PREVIEW_FILE_TOO_LARGE"
          : "MEDIA_FILE_TOO_LARGE";
        throw new Error(`${errorCode}:${asset.name}`);
      }
      const destination = join(stagingDir, asset.path);
      mkdirSync(dirname(destination), { recursive: true });
      await streamZipEntryToFile(zipPath, asset.path, destination, asset);
      probeImportedMedia(destination, asset);
      stagedAssets.push({ asset, storagePath: join("versions", versionId, asset.path) });
    }
    promoted = await blobStore.promoteDirectory(stagingDir, listingId, join("versions", versionId), job.id);
    const ts = nowIso();
    const previousIncludedBySha = new Map<string, number>();
    if (existing?.active_version_id) {
      const previousAssets = db.prepare(
        `SELECT sha256, included FROM listing_assets
         WHERE version_id = ? AND stripped = 0`
      ).all(existing.active_version_id) as { sha256: string; included: number }[];
      for (const previous of previousAssets) previousIncludedBySha.set(previous.sha256, previous.included);
    }
    const versionCoverPath = stagedAssets.find((row) => row.asset.kind === "poster")?.storagePath ?? null;
    try {
      withTransaction(() => {
        if (existing) {
          db.prepare(
            `UPDATE listings SET source_run_id = ?, source_run_index = ?, updated_at = ? WHERE id = ?`
          ).run(manifest.run_id, manifest.run_index, ts, listingId);
        } else {
          db.prepare(
            `INSERT INTO listings (
              id, title, summary, cover_path, author_user_id, source_task_id, source_run_id, source_run_index,
              price_tier, price_credits, status, like_count, download_count, created_at, published_at, updated_at
            ) VALUES (?, ?, '', NULL, ?, ?, ?, ?, 'standard', 0, 'draft', 0, 0, ?, NULL, ?)`
          ).run(listingId, manifest.title, job.admin_user_id, manifest.task_id, manifest.run_id, manifest.run_index, ts, ts);
        }
        db.prepare(
          `INSERT INTO listing_versions (
            id, listing_id, schema_version, package_sha256, export_fingerprint, status,
            source_run_id, source_run_index, cover_path, created_at, activated_at
          ) VALUES (?, ?, 'resource-gallery.export/v2', ?, ?, 'draft', ?, ?, ?, ?, NULL)`
        ).run(versionId, listingId, packageSha, exportFingerprintValue, manifest.run_id, manifest.run_index, versionCoverPath, ts);
        const assetIds = new Map<string, string>();
        for (const row of [...stagedAssets].sort((a, b) => Number(Boolean(a.asset.parent_file_id)) - Number(Boolean(b.asset.parent_file_id)))) {
          const assetId = id("asset");
          assetIds.set(row.asset.id, assetId);
          const media = row.asset.media;
          const preview = ["poster", "preview_audio", "preview_video"].includes(row.asset.kind);
          const fullMedia = ["audio_overview", "video_overview"].includes(row.asset.kind);
          const requiresFreshCuration = preview || fullMedia || row.asset.kind === "subtitle";
          const defaultIncluded = requiresFreshCuration
            ? 0
            : row.asset.default_include ? 1 : 0;
          const previewPolicy = preview
            ? "public"
            : fullMedia
              ? "derived_only"
              : defaultIncluded && row.asset.kind !== "subtitle" && isPreviewableArtifact(row.asset.kind, row.asset.name)
                ? "public"
                : "none";
          db.prepare(
            `INSERT INTO listing_assets (
              id, version_id, upstream_asset_id, variant_group_id, parent_asset_id, kind, filename, storage_path, size_bytes, sha256,
              mime_type, duration_ms, width, height, audio_codec, video_codec, language, provenance,
              preview_policy, entitlement_download, included, stripped, source_run_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
          ).run(
            assetId, versionId, row.asset.id, row.asset.variant_group_id ?? null,
            row.asset.parent_file_id ? assetIds.get(row.asset.parent_file_id) ?? null : null,
            row.asset.kind, row.asset.name, row.storagePath, row.asset.size_bytes, row.asset.sha256,
            media?.mime_type ?? null, media?.duration_ms ?? null, media?.width ?? null, media?.height ?? null,
            media?.audio_codec ?? null, media?.video_codec ?? null, media?.language ?? null,
            row.asset.provenance ?? "pipeline", previewPolicy,
            row.asset.distribution?.entitlement_download ? 1 : 0,
            requiresFreshCuration ? defaultIncluded : previousIncludedBySha.get(row.asset.sha256) ?? defaultIncluded,
            row.asset.source_run_id ?? null
          );
        }
        db.prepare(
          `UPDATE import_jobs SET status = 'succeeded', message = ?, listing_id = ?, source_task_id = ?, source_run_id = ?, finished_at = ? WHERE id = ?`
        ).run(`v2 媒体包已导入为草稿版本 ${versionId}`, listingId, manifest.task_id, manifest.run_id, ts, job.id);
        db.prepare(
          `INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, detail, created_at)
           VALUES (?, ?, 'import.v2_succeeded', 'listing_version', ?, ?, ?)`
        ).run(id("aud"), job.admin_user_id, versionId, JSON.stringify({ listing_id: listingId, asset_count: stagedAssets.length }), ts);
      });
    } catch (error) {
      await promoted?.rollback();
      throw error;
    }
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    importFailure(job, error instanceof Error ? error.message : "v2 导入失败");
  }
}

export async function processImportJob(jobId: string, zipPath: string, options: ImportOptions = {}): Promise<void> {
  const db = getDb();
  const job = db.prepare("SELECT * FROM import_jobs WHERE id = ?").get(jobId) as
    | { id: string; admin_user_id: string; filename: string }
    | undefined;
  if (!job) return;

  db.prepare(
    "UPDATE import_jobs SET status = 'processing', message = ? WHERE id = ?"
  ).run("validating", jobId);

  const v2Metadata = await readV2PackageMetadata(zipPath, {
    maxPackageBytes: config.maxPackageBytes,
    maxUncompressedBytes: config.maxUncompressedPackageBytes
  });
  if (v2Metadata.manifest?.schema_version === "resource-gallery.export/v2") {
    if (v2Metadata.ok && rejectUnexpectedTaskId(job, options.expectedTaskId, v2Metadata.manifest.task_id)) {
      return;
    }
    await processV2ImportJob(job, zipPath, v2Metadata);
    return;
  }

  const v1Metadata = await readV1PackageMetadata(zipPath, {
    maxPackageBytes: config.maxPackageBytes,
    maxUncompressedBytes: config.maxUncompressedPackageBytes
  });

  if (!v1Metadata.ok || !v1Metadata.manifest || !v1Metadata.taskMeta || !v1Metadata.runMeta || v1Metadata.manifest.schema_version !== "resource-gallery.export/v1") {
    importFailure(job, metadataFailureMessage(v1Metadata, "v1 包校验失败"));
    return;
  }

  const manifest = v1Metadata.manifest;
  if (rejectUnexpectedTaskId(job, options.expectedTaskId, manifest.task_id)) return;
  const taskMeta = v1Metadata.taskMeta;
  const runMeta = v1Metadata.runMeta;
  const toValidatedFile = (file: typeof manifest.files[number]): ValidatedFile => {
    const dangerous = isDangerousKind(file.kind, file.name);
    return {
      path: file.path,
      name: file.name,
      kind: file.kind,
      sha256: file.sha256.toLowerCase(),
      size_bytes: file.size_bytes,
      default_include: file.default_include ?? ["slide_pdf", "slide_deck", "infographic", "content", "blueprint", "prompt", "source_context"].includes(file.kind),
      stripped: dangerous,
      strip_reason: dangerous ? "default_strip_policy" : undefined
    };
  };
  const validatedFiles = manifest.files.map(toValidatedFile);
  const keptFiles = validatedFiles.filter((file) => !file.stripped);
  const strippedFiles = validatedFiles.filter((file) => file.stripped);
  if (!keptFiles.length) {
    importFailure(job, "剥离危险文件后无可用文件，拒绝整包");
    return;
  }

  // Resource Gallery manages one resource per Video2PPT task. Pipeline runs are
  // retained only as provenance and must not create duplicate listings.
  const existing = db
    .prepare(
      `SELECT id, status, title, summary, summary_status, summary_origin,
              summary_source_hash, summary_model, summary_generated_at, summary_locked,
              tag_status, tag_origin, tag_source_hash, tag_model, tag_generated_at, tag_locked,
              price_tier, price_credits, cover_path
       FROM listings
       WHERE source_task_id = ?`
    )
    .get(manifest.task_id) as
    | {
        id: string;
        status: string;
        title: string;
        summary: string;
        summary_status: string;
        summary_origin: string;
        summary_source_hash: string | null;
        summary_model: string | null;
        summary_generated_at: string | null;
        summary_locked: number;
        tag_status: string;
        tag_origin: string;
        tag_source_hash: string | null;
        tag_model: string | null;
        tag_generated_at: string | null;
        tag_locked: number;
        price_tier: string;
        price_credits: number;
        cover_path: string | null;
      }
    | undefined;

  const listingId = existing?.id ?? id("lst");
  const exportFingerprint = sha256(JSON.stringify({
    task_id: manifest.task_id,
    run_id: manifest.run_id,
    files: [...keptFiles, ...strippedFiles].map((file) => [file.path, file.sha256, file.size_bytes])
  }));
  const duplicateVersion = existing
    ? db.prepare(`SELECT id FROM listing_versions WHERE listing_id = ? AND export_fingerprint = ?`)
      .get(existing.id, exportFingerprint) as { id: string } | undefined
    : undefined;
  if (duplicateVersion) {
    db.prepare(
      `UPDATE import_jobs SET status = 'succeeded', message = ?, listing_id = ?, source_task_id = ?, source_run_id = ?, finished_at = ? WHERE id = ?`
    ).run("v1 包已导入，复用已有版本", listingId, manifest.task_id, manifest.run_id, nowIso(), jobId);
    return;
  }
  const stagingDir = join(config.blobRoot, `.import-${jobId}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const writeKept = async (f: ValidatedFile) => {
    const destName = f.path.replace(/^files\//, "");
    const dest = join(stagingDir, destName);
    mkdirSync(join(dest, ".."), { recursive: true });
    await streamZipEntryToFile(zipPath, f.path, dest, f);
    return destName;
  };

  let stored: Array<ValidatedFile & { storageRel: string }>;
  try {
    stored = [];
    for (const file of keptFiles) stored.push({ ...file, storageRel: await writeKept(file) });
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    importFailure(job, error instanceof Error ? error.message : "v1 文件流式校验失败");
    return;
  }

  const summarySources: SummarySourceFile[] = stored
    .filter((file) => isSummaryTextFile(file.kind, file.name))
    .map((file) => ({
      kind: file.kind,
      name: file.name,
      sha256: file.sha256,
      content: readFileSync(join(stagingDir, file.storageRel), "utf8")
    }));

  const image = stored.find((file) =>
    [".png", ".jpg", ".jpeg", ".webp"].includes(extname(file.storageRel).toLowerCase())
  );
  const coverPath = image?.storageRel ?? null;

  const tier = db.prepare("SELECT * FROM price_tiers WHERE id = 'standard'").get() as
    | { id: string; credits: number }
    | undefined;
  const defaultPriceCredits = tier?.credits ?? 12;
  const ts = nowIso();

  // Draft re-imports refresh package files/provenance, but keep operator curation.
  const previousFiles = existing
    ? (db
        .prepare(
          `SELECT sha256, included, filename
           FROM listing_files
           WHERE listing_id = ? AND stripped = 0`
        )
        .all(existing.id) as { sha256: string; included: number; filename: string }[])
    : [];
  const previousIncludedBySha = new Map(
    previousFiles.map((file) => [file.sha256, file.included === 1] as const)
  );
  const previousTags = existing
    ? (db
        .prepare(`SELECT tag, topic_id FROM listing_tags WHERE listing_id = ?`)
        .all(existing.id) as { tag: string; topic_id: string | null }[])
    : [];

  const nextTitle = existing?.title?.trim() ? existing.title : manifest.title;
  const legacyOperatorSummary = Boolean(
    existing?.summary?.trim() &&
      existing.summary.trim() !== existing.title.trim() &&
      !existing.summary_source_hash
  );
  const summaryLocked = Boolean(
    existing?.summary_locked || existing?.summary_origin === "operator" || legacyOperatorSummary
  );
  const currentSourceHash = summarySourceHash(summarySources);
  const llmConfigured = summaryLlmConfigured();
  const needsLlmUpgrade = Boolean(
    llmConfigured && existing?.summary_origin === "fallback" && !existing?.summary_model
  );
  let summaryResult: ListingSummaryResult;
  if (summaryLocked && existing) {
    summaryResult = {
      summary: existing.summary,
      status: "ready",
      origin: "fallback",
      sourceHash: existing.summary_source_hash ?? "",
      model: existing.summary_model,
      generatedAt: existing.summary_generated_at ?? ts
    };
  } else if (
    existing?.summary?.trim() &&
    existing.summary_status === "ready" &&
    existing.summary_source_hash === currentSourceHash &&
    !needsLlmUpgrade
  ) {
    summaryResult = {
      summary: existing.summary,
      status: "ready",
      origin: existing.summary_origin === "llm" ? "llm" : "fallback",
      sourceHash: currentSourceHash,
      model: existing.summary_model,
      generatedAt: existing.summary_generated_at ?? ts
    };
  } else {
    summaryResult = await generateListingSummary({
      title: nextTitle,
      files: summarySources,
      llm: summaryLlmOptions()
    });
  }
  const tagsLocked = Boolean(existing?.tag_locked);
  const currentTagSourceHash = tagSourceHash(nextTitle, summaryResult.summary, summarySources);
  const preserveTags = Boolean(
    existing && (tagsLocked || existing.tag_source_hash === currentTagSourceHash)
  );
  const tagResult: ListingTagResult = preserveTags
    ? {
        topicId: (previousTags[0]?.topic_id ?? "other") as ListingTagResult["topicId"],
        tags: previousTags.map((tag) => tag.tag),
        confidence: "high",
        origin: "fallback",
        sourceHash: existing?.tag_source_hash ?? currentTagSourceHash,
        model: existing?.tag_model ?? null,
        generatedAt: existing?.tag_generated_at ?? ts
      }
    : await generateListingTags({
        title: nextTitle,
        summary: summaryResult.summary,
        files: summarySources,
        llm: summaryLlmOptions()
      });
  const nextSummary = summaryResult.summary;
  const nextPriceTier = existing?.price_tier || "standard";
  const nextPriceCredits =
    existing && Number.isFinite(existing.price_credits)
      ? existing.price_credits
      : defaultPriceCredits;
  const preservedFileSelections = previousIncludedBySha.size;
  const preservedTagCount = previousTags.length;
  const versionId = id("ver");
  const versionCoverPath = coverPath
    ? join("versions", versionId, coverPath).replaceAll("\\", "/")
    : null;
  // A review import must leave the currently published cover untouched until its draft version is promoted.
  const nextCoverPath = existing?.status === "published"
    ? existing.cover_path ?? null
    : versionCoverPath ?? existing?.cover_path ?? null;
  const packageSha = await sha256File(zipPath);

  let promoted: PromotedDirectory | undefined;
  promoted = await blobStore.promoteDirectory(stagingDir, listingId, join("versions", versionId), job.id);

  type LegacyAssetRow = {
    id: string;
    path: string;
    name: string;
    kind: string;
    sha256: string;
    size_bytes: number;
    storageRel?: string;
    included: number;
    stripped: boolean;
  };
  const storedRows: LegacyAssetRow[] = stored.map((file) => ({
    ...file,
    id: id("file"),
    included: 1,
    stripped: false
  }));
  for (const file of storedRows) {
    if (previousIncludedBySha.has(file.sha256)) file.included = previousIncludedBySha.get(file.sha256) ? 1 : 0;
  }
  const strippedRows: LegacyAssetRow[] = strippedFiles.map((file) => ({
    ...file,
    id: id("file"),
    included: 0,
    stripped: true
  }));

  try {
    withTransaction(() => {
    if (existing) {
      db.prepare("DELETE FROM listing_files WHERE listing_id = ?").run(listingId);
      // Keep curated tags; only seed tags for brand-new listings.
      db.prepare(
        `UPDATE listings SET
          title = ?, summary = ?, summary_status = ?, summary_origin = ?,
          summary_source_hash = ?, summary_model = ?, summary_generated_at = ?, summary_locked = ?,
          tag_status = ?, tag_origin = ?, tag_source_hash = ?, tag_model = ?, tag_generated_at = ?, tag_locked = ?,
          cover_path = ?, source_run_id = ?, source_run_index = ?,
          price_tier = ?, price_credits = ?, status = ?,
          updated_at = ?
         WHERE id = ?`
      ).run(
        nextTitle,
        nextSummary,
        summaryResult.status,
        summaryLocked ? "operator" : summaryResult.origin,
        summaryResult.sourceHash || existing.summary_source_hash,
        summaryResult.model,
        summaryResult.generatedAt,
        summaryLocked ? 1 : 0,
        preserveTags ? existing.tag_status : "ready",
        preserveTags ? "operator" : tagResult.origin,
        preserveTags ? existing.tag_source_hash : tagResult.sourceHash,
        preserveTags ? existing.tag_model : tagResult.model,
        preserveTags ? existing.tag_generated_at : tagResult.generatedAt,
        preserveTags ? 1 : 0,
        nextCoverPath,
        manifest.run_id,
        manifest.run_index,
        nextPriceTier,
        nextPriceCredits,
        existing.status,
        ts,
        listingId
      );
    } else {
      db.prepare(
        `INSERT INTO listings (
          id, title, summary, summary_status, summary_origin, summary_source_hash,
          summary_model, summary_generated_at, summary_locked,
          tag_status, tag_origin, tag_source_hash, tag_model, tag_generated_at, tag_locked,
          cover_path, author_user_id,
          source_task_id, source_run_id, source_run_index,
          price_tier, price_credits, status, like_count, download_count,
          created_at, published_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'standard', ?, 'draft', 0, 0, ?, NULL, ?)`
      ).run(
        listingId,
        nextTitle,
        nextSummary,
        summaryResult.status,
        summaryResult.origin,
        summaryResult.sourceHash,
        summaryResult.model,
        summaryResult.generatedAt,
        "ready",
        tagResult.origin,
        tagResult.sourceHash,
        tagResult.model,
        tagResult.generatedAt,
        nextCoverPath,
        job.admin_user_id,
        manifest.task_id,
        manifest.run_id,
        manifest.run_index,
        nextPriceCredits,
        ts,
        ts
      );
    }

    for (const f of storedRows) {
      db.prepare(
        `INSERT INTO listing_files (
          id, listing_id, kind, filename, storage_path, size_bytes, sha256,
          is_previewable, included, stripped
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      ).run(
        f.id,
        listingId,
        f.kind,
        f.name,
        f.storageRel ?? "",
        f.size_bytes,
        f.sha256,
        isPreviewableArtifact(f.kind, f.name) ? 1 : 0,
        f.included
      );
    }

    for (const f of strippedRows) {
      db.prepare(
        `INSERT INTO listing_files (
          id, listing_id, kind, filename, storage_path, size_bytes, sha256,
          is_previewable, included, stripped
        ) VALUES (?, ?, ?, ?, '', ?, ?, 0, 0, 1)`
      ).run(f.id, listingId, f.kind, f.name, f.size_bytes, f.sha256);
    }

    db.prepare(`UPDATE listing_versions SET status = 'superseded' WHERE listing_id = ? AND status = 'draft'`).run(listingId);
    db.prepare(
      `INSERT INTO listing_versions (
        id, listing_id, schema_version, package_sha256, export_fingerprint, status,
        source_run_id, source_run_index, cover_path, created_at, activated_at
      ) VALUES (?, ?, 'resource-gallery.export/v1', ?, ?, 'draft', ?, ?, ?, ?, NULL)`
    ).run(versionId, listingId, packageSha, exportFingerprint, manifest.run_id, manifest.run_index, versionCoverPath, ts);
    for (const f of [...storedRows, ...strippedRows]) {
      const included = "included" in f ? f.included : 0;
      const stripped = "stripped" in f ? (f.stripped ? 1 : 0) : 1;
      const previewPolicy = !stripped && included && isPreviewableArtifact(f.kind, f.name) ? "public" : "none";
      const storagePath = stripped || !f.storageRel ? "" : join("versions", versionId, f.storageRel).replaceAll("\\", "/");
      db.prepare(
        `INSERT INTO listing_assets (
          id, version_id, upstream_asset_id, parent_asset_id, kind, filename, storage_path, size_bytes, sha256,
          mime_type, duration_ms, width, height, audio_codec, video_codec, language, provenance,
          preview_policy, entitlement_download, included, stripped, source_run_id
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'pipeline', ?, 0, ?, ?, ?)`
      ).run(
        f.id, versionId, f.path, f.kind, f.name, storagePath, f.size_bytes, f.sha256,
        previewPolicy, included, stripped, manifest.run_id
      );
    }

    if (!preserveTags) {
      db.prepare(`DELETE FROM listing_tags WHERE listing_id = ?`).run(listingId);
      for (const tag of tagResult.tags) {
        db.prepare(
          `INSERT OR IGNORE INTO listing_tags (listing_id, tag, topic_id) VALUES (?, ?, ?)`
        ).run(listingId, tag, tagResult.topicId);
      }
    }

    const preserveNote = existing
      ? `；保留策展 title/summary/price/${preserveTags ? "tags" : "重建内容标签"}，回填 ${preservedFileSelections} 个文件选择`
      : "";
    db.prepare(
      `UPDATE import_jobs
       SET status = 'succeeded', message = ?, listing_id = ?, source_task_id = ?, source_run_id = ?, finished_at = ?
       WHERE id = ?`
    ).run(
      `任务资源草稿已生成；剥离 ${strippedFiles.length} 个危险文件${preserveNote}`,
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
        stripped: strippedFiles.map((f) => f.path),
        task_id: manifest.task_id,
        run_id: manifest.run_id,
        preserved_curation: Boolean(existing),
        preserved_file_selections: preservedFileSelections,
        preserved_tags: preservedTagCount
      }),
      nowIso()
    );
    });
  } catch (error) {
    await promoted?.rollback();
    throw error;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function packageShaPlaceholder(zipPath: string): string {
  return sha256(readFileSync(zipPath));
}

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, normalize, sep, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import yauzl from "yauzl";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_INCLUDE_KINDS,
  DEFAULT_STRIP_KINDS,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  type AnyExportManifest,
  type ArtifactKind,
  type ExportManifest,
  type ExportManifestV2,
  type ManifestAsset,
  type PackageMetadataResult,
  type RunMeta,
  type TaskMeta,
  type ValidatedFile,
  type ValidationIssue,
  type ValidationResult
} from "./types.js";

const require = createRequire(import.meta.url);
// Prefer draft 2020 export when available
let AjvCtor: new (opts?: object) => {
  compile: (schema: object) => ((data: unknown) => boolean) & {
    errors?: Array<{ instancePath?: string; message?: string }>;
  };
};
try {
  AjvCtor = require("ajv/dist/2020.js");
} catch {
  AjvCtor = require("ajv");
}
const addFormats = require("ajv-formats") as (ajv: unknown) => unknown;

const schemaPath = fileURLToPath(
  new URL("../schema/resource-gallery.export.v1.json", import.meta.url)
);
const schemaV1 = JSON.parse(readFileSync(schemaPath, "utf8"));
const schemaV2Path = fileURLToPath(
  new URL("../schema/resource-gallery.export.v2.json", import.meta.url)
);
const schemaV2 = JSON.parse(readFileSync(schemaV2Path, "utf8"));

const ajv = new AjvCtor({ allErrors: true, strict: false });
addFormats(ajv);
const validateManifestV1 = ajv.compile(schemaV1);
const validateManifestV2 = ajv.compile(schemaV2);

const AUTH_NAME_RE = /(cookie|cookies|auth|credential|token|secret|password|passphrase|access[_-]?key|\.env)/i;
const SENSITIVE_REFERENCE_KEY_RE = /(?:^|_)(?:url|uri|cookie(?:s)?|auth(?:orization)?|credential(?:s)?|token|secret|password|pass(?:word|phrase)?|access[_-]?key|download_(?:url|link))(?:$|_)|(?:^|_)notebook(?:lm)?(?:_|$)/i;
const EXTERNAL_OR_ABSOLUTE_REFERENCE_RE = /(?:https?|file):\/\/|(?:^|[\s"'`(])\/(?!\/)[^\s"'`)]*/i;

function assetFilenameKey(name: string): string {
  // Asset filenames are route selectors. Normalize macOS decomposed Unicode
  // and case-insensitive filesystem spellings before checking uniqueness.
  return name.normalize("NFC").toLowerCase();
}

function containsSensitiveReference(value: unknown): boolean {
  if (typeof value === "string") return EXTERNAL_OR_ABSOLUTE_REFERENCE_RE.test(value);
  if (Array.isArray(value)) return value.some(containsSensitiveReference);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => SENSITIVE_REFERENCE_KEY_RE.test(key) || containsSensitiveReference(nested)
  );
}

export function isDangerousKind(kind: string, name: string): boolean {
  if ((DEFAULT_STRIP_KINDS as string[]).includes(kind)) return true;
  if (kind === "auth") return true;
  if (AUTH_NAME_RE.test(name)) return true;
  return false;
}

export function assertSafePackagePath(entryPath: string): ValidationIssue | null {
  const replaced = entryPath.replace(/\\/g, "/");
  if (!replaced || replaced.startsWith("/") || /^[a-zA-Z]:/.test(replaced)) {
    return { code: "PATH_ABSOLUTE", message: `绝对路径被拒绝: ${entryPath}`, path: entryPath };
  }
  if (replaced.includes("\0")) {
    return { code: "PATH_NULL", message: `路径含非法字符: ${entryPath}`, path: entryPath };
  }
  const segments = replaced.split("/");
  if (segments.some((s) => s === "..")) {
    return { code: "PATH_ESCAPE", message: `路径逃逸被拒绝: ${entryPath}`, path: entryPath };
  }
  if (segments.some((s) => s === "")) {
    return { code: "PATH_EMPTY_SEGMENT", message: `路径含空片段: ${entryPath}`, path: entryPath };
  }
  const normalized = normalize(replaced);
  if (normalized.startsWith("..") || normalized.includes(`${sep}..`)) {
    return { code: "PATH_ESCAPE", message: `路径逃逸被拒绝: ${entryPath}`, path: entryPath };
  }
  return null;
}

function readJsonLoose<T>(raw: string, label: string, issues: ValidationIssue[]): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    issues.push({ code: "JSON_PARSE", message: `${label} 不是合法 JSON` });
    return null;
  }
}

export function validateManifestObject(manifest: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const version = (manifest as { schema_version?: unknown })?.schema_version;
  const validateManifest = version === SCHEMA_VERSION_V2 ? validateManifestV2 : validateManifestV1;
  const expectedVersion = version === SCHEMA_VERSION_V2 ? SCHEMA_VERSION_V2 : SCHEMA_VERSION;
  const ok = validateManifest(manifest);
  if (!ok) {
    for (const err of validateManifest.errors ?? []) {
      issues.push({
        code: "SCHEMA",
        message: `${err.instancePath || "/"} ${err.message || "invalid"}`,
        path: err.instancePath
      });
    }
  }
  if (version && version !== expectedVersion) {
    issues.push({
      code: "SCHEMA_VERSION",
      message: `schema_version 必须为 ${SCHEMA_VERSION} 或 ${SCHEMA_VERSION_V2}`
    });
  }
  return issues;
}

function isV2Manifest(manifest: AnyExportManifest): manifest is ExportManifestV2 {
  return manifest.schema_version === SCHEMA_VERSION_V2;
}

function validateV2AssetRelationships(manifest: ExportManifestV2, issues: ValidationIssue[]): void {
  const byId = new Map<string, ManifestAsset>();
  const byPath = new Map<string, ManifestAsset>();
  const byFilename = new Map<string, ManifestAsset>();
  const mediaKinds = new Set(["audio_overview", "video_overview", "preview_audio", "preview_video"]);
  const derivedKinds = new Set(["subtitle", "poster", "preview_audio", "preview_video"]);
  const publicPreviewKinds = new Set(["poster", "preview_audio", "preview_video"]);
  const fullMediaKinds = new Set(["audio_overview", "video_overview"]);
  const forbiddenKinds = new Set(["video", "auth"]);
  const fullMediaGroups = new Map<string, ManifestAsset>();

  for (const asset of manifest.assets) {
    if (byId.has(asset.id)) {
      issues.push({ code: "ASSET_ID_DUPLICATE", message: `资产 id 重复: ${asset.id}`, path: asset.path });
    }
    byId.set(asset.id, asset);
    const previousPath = byPath.get(asset.path);
    if (previousPath) {
      issues.push({ code: "ASSET_PATH_DUPLICATE", message: `资产路径重复: ${asset.path}`, path: asset.path });
    } else {
      byPath.set(asset.path, asset);
    }
    const filenameKey = assetFilenameKey(asset.name);
    const previousFilename = byFilename.get(filenameKey);
    if (previousFilename) {
      issues.push({
        code: "ASSET_FILENAME_COLLISION",
        message: `资产文件名在跨平台规范化后冲突: ${previousFilename.name} / ${asset.name}`,
        path: asset.path
      });
    } else {
      byFilename.set(filenameKey, asset);
    }
    const needsPreviewPath = asset.kind === "poster" || asset.kind === "preview_audio" || asset.kind === "preview_video";
    if (needsPreviewPath ? !asset.path.startsWith("preview/") : !asset.path.startsWith("files/")) {
      issues.push({ code: "ASSET_PATH_PREFIX", message: `资产路径与 kind 不匹配: ${asset.path}`, path: asset.path });
    }
    if (asset.kind === "video") {
      issues.push({ code: "SOURCE_MEDIA_FORBIDDEN", message: "v2 不接受来源视频", path: asset.path });
    } else if (forbiddenKinds.has(asset.kind) || AUTH_NAME_RE.test(asset.name)) {
      issues.push({
        code: "DANGEROUS_ASSET_FORBIDDEN",
        message: "v2 不接受认证材料或敏感命名资产",
        path: asset.path
      });
    }
    if (mediaKinds.has(asset.kind) && !asset.media) {
      issues.push({ code: "MEDIA_METADATA_REQUIRED", message: `媒体缺少 media 元数据: ${asset.path}`, path: asset.path });
    }
    if (mediaKinds.has(asset.kind) && asset.size_bytes <= 0) {
      issues.push({ code: "MEDIA_EMPTY", message: `媒体文件不能为空: ${asset.path}`, path: asset.path });
    }
    if (fullMediaKinds.has(asset.kind)) {
      const groupKey = `${asset.kind}:${asset.variant_group_id ?? asset.kind}`;
      const previous = fullMediaGroups.get(groupKey);
      if (previous) {
        issues.push({
          code: "MEDIA_VARIANT_AMBIGUOUS",
          message: `同一媒体版本组只能包含一个完整媒体: ${asset.variant_group_id ?? asset.kind}`,
          path: asset.path
        });
      } else {
        fullMediaGroups.set(groupKey, asset);
      }
      if (!asset.distribution) {
        issues.push({ code: "MEDIA_DISTRIBUTION_REQUIRED", message: `完整媒体缺少分发策略: ${asset.path}`, path: asset.path });
      } else if (asset.distribution.public_preview !== "derived_only" || !asset.distribution.entitlement_download) {
        issues.push({ code: "MEDIA_DISTRIBUTION_INVALID", message: `完整媒体必须仅开放衍生预览且需要权益: ${asset.path}`, path: asset.path });
      }
      if (asset.default_include === true) {
        issues.push({ code: "MEDIA_DEFAULT_INCLUDE", message: `完整媒体必须由运营显式纳入: ${asset.path}`, path: asset.path });
      }
    }
    if (publicPreviewKinds.has(asset.kind)) {
      if (!asset.distribution) {
        issues.push({ code: "PREVIEW_DISTRIBUTION_REQUIRED", message: `公开衍生物缺少分发策略: ${asset.path}`, path: asset.path });
      } else if (asset.distribution.public_preview !== "derived_only" || asset.distribution.entitlement_download) {
        issues.push({ code: "PREVIEW_DISTRIBUTION_INVALID", message: `衍生预览必须是 derived_only 且不可下载: ${asset.path}`, path: asset.path });
      }
      if (asset.default_include === true) {
        issues.push({ code: "PREVIEW_DEFAULT_INCLUDE", message: `衍生预览不能进入下载集合: ${asset.path}`, path: asset.path });
      }
    }
    if (asset.kind === "subtitle") {
      if (asset.default_include === true) {
        issues.push({ code: "SUBTITLE_DEFAULT_INCLUDE", message: `字幕不能默认纳入: ${asset.path}`, path: asset.path });
      }
      if (asset.distribution?.public_preview && asset.distribution.public_preview !== "none") {
        issues.push({ code: "SUBTITLE_DISTRIBUTION_INVALID", message: `字幕不能单独公开预览: ${asset.path}`, path: asset.path });
      }
    }
    if (derivedKinds.has(asset.kind) && !asset.parent_file_id) {
      issues.push({ code: "ASSET_PARENT_REQUIRED", message: `衍生资产必须关联父媒体: ${asset.path}`, path: asset.path });
    }
  }

  for (const asset of manifest.assets) {
    if (!derivedKinds.has(asset.kind) || !asset.parent_file_id) continue;
    const parent = byId.get(asset.parent_file_id);
    if (!parent || !fullMediaKinds.has(parent.kind)) {
      issues.push({ code: "ASSET_PARENT_INVALID", message: `衍生资产父媒体无效: ${asset.path}`, path: asset.path });
      continue;
    }
    if (
      (asset.kind === "preview_audio" && parent.kind !== "audio_overview") ||
      ((asset.kind === "poster" || asset.kind === "preview_video") && parent.kind !== "video_overview")
    ) {
      issues.push({ code: "ASSET_PARENT_KIND_INVALID", message: `衍生资产与父媒体类型不匹配: ${asset.path}`, path: asset.path });
    }
  }
}

class ZipUncompressedLimitError extends Error {}
class ZipMetadataLimitError extends Error {}
class ZipDuplicateEntryError extends Error {}

export async function openZipEntries(
  zipPath: string,
  options?: { maxUncompressedBytes?: number; entryPaths?: ReadonlySet<string> }
): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
  const maxUncompressedBytes = options?.maxUncompressedBytes ?? 512 * 1024 * 1024;
  let totalUncompressedBytes = 0;
  await new Promise<void>((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error("无法打开 zip"));
        return;
      }
      zip.readEntry();
      zip.on("entry", (entry) => {
        const name = String(entry.fileName).replace(/\\/g, "/");
        if (/\/$/.test(name)) {
          zip.readEntry();
          return;
        }
        if (
          entry.uncompressedSize > maxUncompressedBytes ||
          totalUncompressedBytes + entry.uncompressedSize > maxUncompressedBytes
        ) {
          reject(new ZipUncompressedLimitError("ZIP 解压后总体积超过允许上限"));
          return;
        }
        totalUncompressedBytes += entry.uncompressedSize;
        if (options?.entryPaths && !options.entryPaths.has(name)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) {
            reject(e2 ?? new Error(`无法读取 ${name}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          stream.on("error", reject);
          stream.on("end", () => {
            map.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolvePromise());
      zip.on("error", reject);
    });
  });
  return map;
}

/**
 * Read only the three small package metadata entries. Asset bytes are never
 * materialized here; they are streamed and hashed by streamZipEntryDigest or
 * streamZipEntryToFile after the manifest has been validated.
 */
async function readZipMetadataFiles(
  zipPath: string,
  entryPaths: ReadonlySet<string>,
  maxEntryBytes = 16 * 1024 * 1024
): Promise<Record<string, string>> {
  const files = new Map<string, string>();
  let completed = false;
  await new Promise<void>((resolvePromise, reject) => {
    const fail = (error: Error) => {
      if (completed) return;
      completed = true;
      reject(error);
    };
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return fail(err ?? new Error("无法打开 zip"));
      zip.readEntry();
      zip.on("entry", (entry) => {
        const name = String(entry.fileName).replace(/\\/g, "/");
        if (!entryPaths.has(name) || files.has(name)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error(`无法读取 ${name}`));
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += data.byteLength;
            if (size > maxEntryBytes) {
              stream.destroy(new ZipMetadataLimitError(`元数据条目超过 ${maxEntryBytes} 字节: ${name}`));
              return;
            }
            chunks.push(data);
          });
          stream.on("error", (streamFailure) => fail(streamFailure instanceof Error ? streamFailure : new Error(`无法读取 ${name}`)));
          stream.on("end", () => {
            if (completed) return;
            files.set(name, Buffer.concat(chunks).toString("utf8"));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => {
        if (!completed) {
          completed = true;
          resolvePromise();
        }
      });
      zip.on("error", fail);
    });
  });
  return Object.fromEntries(files);
}

export async function listZipEntries(
  zipPath: string,
  options?: { maxUncompressedBytes?: number }
): Promise<Map<string, number>> {
  const entries = new Map<string, number>();
  const maxUncompressedBytes = options?.maxUncompressedBytes ?? 512 * 1024 * 1024;
  let totalUncompressedBytes = 0;
  await new Promise<void>((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error("无法打开 zip"));
        return;
      }
      zip.readEntry();
      zip.on("entry", (entry) => {
        const name = String(entry.fileName).replace(/\\/g, "/");
        if (!/\/$/.test(name)) {
          if (entries.has(name)) {
            reject(new ZipDuplicateEntryError(`ZIP 条目路径重复: ${name}`));
            return;
          }
          if (
            entry.uncompressedSize > maxUncompressedBytes ||
            totalUncompressedBytes + entry.uncompressedSize > maxUncompressedBytes
          ) {
            reject(new ZipUncompressedLimitError("ZIP 解压后总体积超过允许上限"));
            return;
          }
          totalUncompressedBytes += entry.uncompressedSize;
          entries.set(name, entry.uncompressedSize);
        }
        zip.readEntry();
      });
      zip.on("end", () => resolvePromise());
      zip.on("error", reject);
    });
  });
  return entries;
}

export async function streamZipEntryToFile(
  zipPath: string,
  entryPath: string,
  destination: string,
  expected: { sha256: string; size_bytes: number }
): Promise<void> {
  let found = false;
  let completed = false;
  await new Promise<void>((resolvePromise, reject) => {
    const fail = (error: Error) => {
      if (completed) return;
      completed = true;
      try {
        unlinkSync(destination);
      } catch {
        // No destination was created.
      }
      reject(error);
    };
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return fail(err ?? new Error("无法打开 zip"));
      zip.readEntry();
      zip.on("entry", (entry) => {
        const name = String(entry.fileName).replace(/\\/g, "/");
        if (name !== entryPath || found) {
          zip.readEntry();
          return;
        }
        found = true;
        zip.openReadStream(entry, async (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error(`无法读取 ${entryPath}`));
          const digest = createHash("sha256");
          let size = 0;
          stream.on("data", (chunk) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            digest.update(data);
            size += data.byteLength;
          });
          try {
            await pipeline(stream, createWriteStream(destination, { flags: "wx" }));
            if (size !== expected.size_bytes || digest.digest("hex").toLowerCase() !== expected.sha256.toLowerCase()) {
              return fail(new Error(`文件哈希或大小不匹配: ${entryPath}`));
            }
            if (!completed) {
              completed = true;
              resolvePromise();
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(`无法写入 ${entryPath}`));
          } finally {
            zip.close();
          }
        });
      });
      zip.on("end", () => {
        if (!found) fail(new Error(`包内缺少文件: ${entryPath}`));
      });
      zip.on("error", fail);
    });
  });
}

async function streamZipEntryDigest(
  zipPath: string,
  entryPath: string
): Promise<{ sha256: string; size_bytes: number }> {
  let found = false;
  let completed = false;
  return new Promise((resolvePromise, reject) => {
    const fail = (error: Error) => {
      if (completed) return;
      completed = true;
      reject(error);
    };
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return fail(err ?? new Error("无法打开 zip"));
      zip.readEntry();
      zip.on("entry", (entry) => {
        const name = String(entry.fileName).replace(/\\/g, "/");
        if (name !== entryPath || found) {
          zip.readEntry();
          return;
        }
        found = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error(`无法读取 ${entryPath}`));
          const digest = createHash("sha256");
          let size = 0;
          stream.on("data", (chunk) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            digest.update(data);
            size += data.byteLength;
          });
          stream.on("error", fail);
          stream.on("end", () => {
            if (completed) return;
            completed = true;
            resolvePromise({ sha256: digest.digest("hex"), size_bytes: size });
            zip.close();
          });
        });
      });
      zip.on("end", () => {
        if (!found) fail(new Error(`包内缺少文件: ${entryPath}`));
      });
      zip.on("error", fail);
    });
  });
}

export async function readV2PackageMetadata(
  inputPath: string,
  options?: { maxPackageBytes?: number; maxUncompressedBytes?: number }
): Promise<PackageMetadataResult> {
  const issues: ValidationIssue[] = [];
  const maxBytes = options?.maxPackageBytes ?? 512 * 1024 * 1024;
  const maxUncompressedBytes = options?.maxUncompressedBytes ?? maxBytes;
  if (!existsSync(inputPath)) {
    return { ok: false, issues: [{ code: "NOT_FOUND", message: `文件不存在: ${inputPath}` }], entryPaths: [] };
  }
  const stat = statSync(inputPath);
  if (!stat.isFile()) {
    return { ok: false, issues: [{ code: "NOT_FILE", message: "输入必须是文件" }], entryPaths: [] };
  }
  if (stat.size > maxBytes) {
    return { ok: false, issues: [{ code: "PACKAGE_TOO_LARGE", message: `包体积 ${stat.size} 超过上限 ${maxBytes}` }], entryPaths: [] };
  }
  let entrySizes: Map<string, number>;
  let metas: Record<string, string>;
  try {
    entrySizes = await listZipEntries(inputPath, { maxUncompressedBytes });
    metas = await readZipMetadataFiles(inputPath, new Set(["manifest.json", "task_meta.json", "run_meta.json"]));
  } catch (error) {
    return {
      ok: false,
      issues: [{
        code: error instanceof ZipUncompressedLimitError
          ? "PACKAGE_UNCOMPRESSED_TOO_LARGE"
          : error instanceof ZipMetadataLimitError
            ? "PACKAGE_METADATA_TOO_LARGE"
            : error instanceof ZipDuplicateEntryError
              ? "ZIP_DUPLICATE_ENTRY"
              : "ZIP_OPEN",
        message: error instanceof Error ? error.message : "无法解析 zip"
      }],
      entryPaths: []
    };
  }
  for (const entryPath of entrySizes.keys()) {
    const pathIssue = assertSafePackagePath(entryPath);
    if (pathIssue) issues.push(pathIssue);
  }
  const manifestText = metas["manifest.json"];
  const taskText = metas["task_meta.json"];
  const runText = metas["run_meta.json"];
  if (!manifestText) issues.push({ code: "MISSING_MANIFEST", message: "缺少 manifest.json" });
  if (!taskText) issues.push({ code: "MISSING_TASK_META", message: "缺少 task_meta.json" });
  if (!runText) issues.push({ code: "MISSING_RUN_META", message: "缺少 run_meta.json" });
  if (!manifestText || !taskText || !runText) return { ok: false, issues, entryPaths: [...entrySizes.keys()] };
  const manifest = readJsonLoose<AnyExportManifest>(manifestText, "manifest.json", issues);
  const taskMeta = readJsonLoose<TaskMeta>(taskText, "task_meta.json", issues);
  const runMeta = readJsonLoose<RunMeta>(runText, "run_meta.json", issues);
  if (!manifest || !taskMeta || !runMeta) return { ok: false, issues, entryPaths: [...entrySizes.keys()] };
  if (!isV2Manifest(manifest)) {
    issues.push({ code: "SCHEMA_VERSION", message: `schema_version 必须为 ${SCHEMA_VERSION_V2}` });
  } else {
    issues.push(...validateManifestObject(manifest));
    validateV2AssetRelationships(manifest, issues);
    const declared = new Set(["manifest.json", "task_meta.json", "run_meta.json", ...manifest.assets.map((asset) => asset.path)]);
    for (const entryPath of entrySizes.keys()) {
      if (!declared.has(entryPath)) {
        issues.push({ code: "ZIP_UNDECLARED_ENTRY", message: `ZIP 条目未在 manifest 中声明: ${entryPath}`, path: entryPath });
      }
    }
    for (const asset of manifest.assets) {
      const size = entrySizes.get(asset.path);
      if (size === undefined) {
        issues.push({ code: "FILE_MISSING", message: `包内缺少文件: ${asset.path}`, path: asset.path });
      } else if (size !== asset.size_bytes) {
        issues.push({ code: "SIZE_MISMATCH", message: `${asset.path} size_bytes 不匹配`, path: asset.path });
      }
    }
  }
  if (taskMeta.task_id !== manifest.task_id) issues.push({ code: "TASK_ID_MISMATCH", message: "task_meta.task_id 与 manifest 不一致" });
  if (runMeta.run_id !== manifest.run_id) issues.push({ code: "RUN_ID_MISMATCH", message: "run_meta.run_id 与 manifest 不一致" });
  if (runMeta.run_index !== manifest.run_index) issues.push({ code: "RUN_INDEX_MISMATCH", message: "run_meta.run_index 与 manifest 不一致" });
  if (containsSensitiveReference({ manifest, taskMeta, runMeta })) {
    issues.push({ code: "SENSITIVE_REFERENCE", message: "导出包不能包含来源 URL、Notebook 标识或本机绝对路径" });
  }
  const metaText = `${JSON.stringify(taskMeta)}\n${JSON.stringify(runMeta)}`;
  if (/cookie|api[_-]?key|authorization|notebook.*token/i.test(metaText)) {
    issues.push({ code: "SENSITIVE_META", message: "task/run meta 疑似包含敏感字段" });
  }
  const fatal = new Set([
    "SCHEMA", "SCHEMA_VERSION", "MISSING_MANIFEST", "MISSING_TASK_META", "MISSING_RUN_META",
    "FILE_MISSING", "SIZE_MISMATCH", "TASK_ID_MISMATCH", "RUN_ID_MISMATCH", "RUN_INDEX_MISMATCH",
    "SENSITIVE_META", "SENSITIVE_REFERENCE", "ASSET_ID_DUPLICATE", "ASSET_PATH_DUPLICATE", "ASSET_FILENAME_COLLISION", "ASSET_PATH_PREFIX", "SOURCE_MEDIA_FORBIDDEN",
    "DANGEROUS_ASSET_FORBIDDEN",
    "ZIP_UNDECLARED_ENTRY",
    "MEDIA_METADATA_REQUIRED", "MEDIA_EMPTY", "MEDIA_DISTRIBUTION_REQUIRED", "MEDIA_DISTRIBUTION_INVALID",
    "MEDIA_DEFAULT_INCLUDE", "MEDIA_VARIANT_AMBIGUOUS", "PREVIEW_DISTRIBUTION_REQUIRED", "PREVIEW_DISTRIBUTION_INVALID", "PREVIEW_DEFAULT_INCLUDE",
    "SUBTITLE_DEFAULT_INCLUDE", "SUBTITLE_DISTRIBUTION_INVALID",
    "ASSET_PARENT_REQUIRED", "ASSET_PARENT_INVALID", "ASSET_PARENT_KIND_INVALID"
  ]);
  const ok = !issues.some((issue) => fatal.has(issue.code) || issue.code.startsWith("PATH_"));
  return { ok, issues, manifest, taskMeta, runMeta, entryPaths: [...entrySizes.keys()] };
}

/**
 * Read and validate a legacy v1 package without materializing its assets.
 * File hashes are verified later while each kept entry is streamed to staging.
 */
export async function readV1PackageMetadata(
  inputPath: string,
  options?: { maxPackageBytes?: number; maxUncompressedBytes?: number }
): Promise<PackageMetadataResult> {
  const base = await readV2PackageMetadata(inputPath, options);
  if (!base.manifest || base.manifest.schema_version !== SCHEMA_VERSION) return base;

  const manifest = base.manifest as ExportManifest;
  const issues = base.issues.filter((issue) => issue.code !== "SCHEMA_VERSION");
  issues.push(...validateManifestObject(manifest));
  const entryPaths = new Set(base.entryPaths);
  const manifestPaths = new Set<string>();
  for (const file of manifest.files) {
    const pathIssue = assertSafePackagePath(file.path);
    if (pathIssue) {
      issues.push(pathIssue);
      continue;
    }
    if (!file.path.startsWith("files/")) {
      issues.push({ code: "FILE_PATH_PREFIX", message: `文件路径不在允许目录: ${file.path}`, path: file.path });
    }
    if (manifestPaths.has(file.path)) {
      issues.push({ code: "FILE_PATH_DUPLICATE", message: `文件路径重复: ${file.path}`, path: file.path });
    }
    manifestPaths.add(file.path);
    if (!entryPaths.has(file.path)) {
      issues.push({ code: "FILE_MISSING", message: `包内缺少文件: ${file.path}`, path: file.path });
    }
  }
  const fatal = new Set([
    "SCHEMA", "SCHEMA_VERSION", "MISSING_MANIFEST", "MISSING_TASK_META", "MISSING_RUN_META",
    "FILE_MISSING", "TASK_ID_MISMATCH", "RUN_ID_MISMATCH", "RUN_INDEX_MISMATCH", "SENSITIVE_META", "SENSITIVE_REFERENCE", "FILE_PATH_PREFIX", "FILE_PATH_DUPLICATE"
  ]);
  return {
    ...base,
    ok: !issues.some((issue) => fatal.has(issue.code) || issue.code.startsWith("PATH_")),
    issues,
    manifest
  };
}

export async function validateExportPackage(
  inputPath: string,
  options?: { maxPackageBytes?: number; maxUncompressedBytes?: number }
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const keptFiles: ValidatedFile[] = [];
  const strippedFiles: ValidatedFile[] = [];
  const metadataProbe = await readV2PackageMetadata(inputPath, options);
  const metadata = metadataProbe.manifest?.schema_version === SCHEMA_VERSION
    ? await readV1PackageMetadata(inputPath, options)
    : metadataProbe;
  issues.push(...metadata.issues);
  const manifest = metadata.manifest;
  const taskMeta = metadata.taskMeta;
  const runMeta = metadata.runMeta;
  if (!metadata.ok || !manifest || !taskMeta || !runMeta) {
    return { ok: false, issues, keptFiles, strippedFiles };
  }

  const packageFiles = isV2Manifest(manifest) ? manifest.assets : manifest.files;
  for (const f of packageFiles) {
    const pathIssue = assertSafePackagePath(f.path);
    if (pathIssue) {
      issues.push(pathIssue);
      continue;
    }
    const isV2Preview = isV2Manifest(manifest) && ["poster", "preview_audio", "preview_video"].includes(f.kind);
    if (!(isV2Preview ? f.path.startsWith("preview/") : f.path.startsWith("files/"))) {
      issues.push({
        code: isV2Manifest(manifest) ? "ASSET_PATH_PREFIX" : "FILE_PATH_PREFIX",
        message: `文件路径不在允许目录: ${f.path}`,
        path: f.path
      });
    }
    let entry: { sha256: string; size_bytes: number };
    try {
      entry = await streamZipEntryDigest(inputPath, f.path);
    } catch {
      issues.push({ code: "FILE_MISSING", message: `包内缺少文件: ${f.path}`, path: f.path });
      continue;
    }
    if (entry.size_bytes !== f.size_bytes) {
      issues.push({
        code: "SIZE_MISMATCH",
        message: `${f.path} size_bytes 不匹配`,
        path: f.path
      });
    }
    if (entry.sha256.toLowerCase() !== f.sha256.toLowerCase()) {
      issues.push({
        code: "SHA256_MISMATCH",
        message: `${f.path} sha256 不匹配`,
        path: f.path
      });
    }

    const dangerous = isDangerousKind(f.kind, f.name);
    const row: ValidatedFile = {
      path: f.path,
      name: f.name,
      kind: f.kind as ArtifactKind,
      sha256: f.sha256.toLowerCase(),
      size_bytes: f.size_bytes,
      default_include: f.default_include ?? (
        isV2Manifest(manifest)
          ? !["audio_overview", "video_overview", "subtitle", "poster", "preview_audio", "preview_video"].includes(f.kind)
          : (DEFAULT_INCLUDE_KINDS as string[]).includes(f.kind)
      ),
      stripped: dangerous,
      strip_reason: dangerous ? "default_strip_policy" : undefined
    };
    if (dangerous) strippedFiles.push(row);
    else keptFiles.push(row);
  }

  if (keptFiles.length === 0) {
    issues.push({
      code: "NO_USABLE_FILES",
      message: "剥离危险文件后无可用文件，拒绝整包"
    });
  }

  const fatalCodes = new Set([
    "SCHEMA",
    "SCHEMA_VERSION",
    "MISSING_MANIFEST",
    "FILE_MISSING",
    "SHA256_MISMATCH",
    "SIZE_MISMATCH",
    "PATH_ESCAPE",
    "PATH_ABSOLUTE",
    "NO_USABLE_FILES",
    "TASK_ID_MISMATCH",
    "RUN_ID_MISMATCH",
    "RUN_INDEX_MISMATCH",
    "SENSITIVE_META",
    "SENSITIVE_REFERENCE",
    "FILE_PATH_PREFIX",
    "ASSET_ID_DUPLICATE",
    "ASSET_PATH_DUPLICATE",
    "ASSET_FILENAME_COLLISION",
    "ASSET_PATH_PREFIX",
    "SOURCE_MEDIA_FORBIDDEN",
    "DANGEROUS_ASSET_FORBIDDEN",
    "MEDIA_METADATA_REQUIRED",
    "MEDIA_EMPTY",
    "MEDIA_DISTRIBUTION_REQUIRED",
    "MEDIA_DISTRIBUTION_INVALID",
    "MEDIA_DEFAULT_INCLUDE",
    "MEDIA_VARIANT_AMBIGUOUS",
    "PREVIEW_DISTRIBUTION_REQUIRED",
    "PREVIEW_DISTRIBUTION_INVALID",
    "PREVIEW_DEFAULT_INCLUDE",
    "SUBTITLE_DEFAULT_INCLUDE",
    "SUBTITLE_DISTRIBUTION_INVALID",
    "ASSET_PARENT_REQUIRED",
    "ASSET_PARENT_INVALID",
    "ASSET_PARENT_KIND_INVALID"
  ]);
  const ok = !issues.some((i) => fatalCodes.has(i.code) || i.code.startsWith("PATH_"));

  return {
    ok,
    issues,
    manifest: ok || issues.length ? manifest : undefined,
    taskMeta,
    runMeta,
    keptFiles,
    strippedFiles
  };
}

export function resolveUnderRoot(root: string, relPath: string): string | null {
  if (assertSafePackagePath(relPath)) return null;
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (isAbsolute(rel) || rel.startsWith("..")) return null;
  return abs;
}

export { SCHEMA_VERSION, SCHEMA_VERSION_V2, DEFAULT_INCLUDE_KINDS, DEFAULT_STRIP_KINDS };

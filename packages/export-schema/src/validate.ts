import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, sep, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import yauzl from "yauzl";
import {
  DEFAULT_INCLUDE_KINDS,
  DEFAULT_STRIP_KINDS,
  SCHEMA_VERSION,
  type ArtifactKind,
  type ExportManifest,
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
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const ajv = new AjvCtor({ allErrors: true, strict: false });
addFormats(ajv);
const validateManifest = ajv.compile(schema);

const AUTH_NAME_RE = /(cookie|cookies|auth|credential|token|secret|\.env)/i;

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
  if (segments.some((s) => s === ".." || s === "")) {
    // allow empty only for trailing? reject .. and empty segments from // 
    if (segments.some((s) => s === "..")) {
      return { code: "PATH_ESCAPE", message: `路径逃逸被拒绝: ${entryPath}`, path: entryPath };
    }
  }
  const normalized = normalize(replaced);
  if (normalized.startsWith("..") || normalized.includes(`${sep}..`)) {
    return { code: "PATH_ESCAPE", message: `路径逃逸被拒绝: ${entryPath}`, path: entryPath };
  }
  return null;
}

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
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
  const m = manifest as ExportManifest;
  if (m && m.schema_version && m.schema_version !== SCHEMA_VERSION) {
    issues.push({
      code: "SCHEMA_VERSION",
      message: `schema_version 必须为 ${SCHEMA_VERSION}`
    });
  }
  return issues;
}

export async function openZipEntries(
  zipPath: string
): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
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

export async function validateExportPackage(
  inputPath: string,
  options?: { maxPackageBytes?: number }
): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const keptFiles: ValidatedFile[] = [];
  const strippedFiles: ValidatedFile[] = [];
  const maxBytes = options?.maxPackageBytes ?? 100 * 1024 * 1024;

  if (!existsSync(inputPath)) {
    return {
      ok: false,
      issues: [{ code: "NOT_FOUND", message: `文件不存在: ${inputPath}` }],
      keptFiles,
      strippedFiles
    };
  }

  const st = statSync(inputPath);
  if (!st.isFile()) {
    return {
      ok: false,
      issues: [{ code: "NOT_FILE", message: "输入必须是文件" }],
      keptFiles,
      strippedFiles
    };
  }
  if (st.size > maxBytes) {
    return {
      ok: false,
      issues: [
        {
          code: "PACKAGE_TOO_LARGE",
          message: `包体积 ${st.size} 超过上限 ${maxBytes}`
        }
      ],
      keptFiles,
      strippedFiles
    };
  }

  let entries: Map<string, Buffer>;
  try {
    entries = await openZipEntries(inputPath);
  } catch (e) {
    return {
      ok: false,
      issues: [
        {
          code: "ZIP_OPEN",
          message: e instanceof Error ? e.message : "无法解析 zip"
        }
      ],
      keptFiles,
      strippedFiles
    };
  }

  for (const name of entries.keys()) {
    const pathIssue = assertSafePackagePath(name);
    if (pathIssue) issues.push(pathIssue);
  }
  if (issues.some((i) => i.code.startsWith("PATH_"))) {
    return { ok: false, issues, keptFiles, strippedFiles };
  }

  const manifestBuf = entries.get("manifest.json");
  const taskBuf = entries.get("task_meta.json");
  const runBuf = entries.get("run_meta.json");
  if (!manifestBuf) issues.push({ code: "MISSING_MANIFEST", message: "缺少 manifest.json" });
  if (!taskBuf) issues.push({ code: "MISSING_TASK_META", message: "缺少 task_meta.json" });
  if (!runBuf) issues.push({ code: "MISSING_RUN_META", message: "缺少 run_meta.json" });
  if (!manifestBuf || !taskBuf || !runBuf) {
    return { ok: false, issues, keptFiles, strippedFiles };
  }

  const manifest = readJsonLoose<ExportManifest>(manifestBuf.toString("utf8"), "manifest.json", issues);
  const taskMeta = readJsonLoose<TaskMeta>(taskBuf.toString("utf8"), "task_meta.json", issues);
  const runMeta = readJsonLoose<RunMeta>(runBuf.toString("utf8"), "run_meta.json", issues);
  if (!manifest || !taskMeta || !runMeta) {
    return { ok: false, issues, keptFiles, strippedFiles };
  }

  issues.push(...validateManifestObject(manifest));

  if (taskMeta.task_id !== manifest.task_id) {
    issues.push({ code: "TASK_ID_MISMATCH", message: "task_meta.task_id 与 manifest 不一致" });
  }
  if (runMeta.run_id !== manifest.run_id) {
    issues.push({ code: "RUN_ID_MISMATCH", message: "run_meta.run_id 与 manifest 不一致" });
  }
  if (runMeta.run_index !== manifest.run_index) {
    issues.push({ code: "RUN_INDEX_MISMATCH", message: "run_meta.run_index 与 manifest 不一致" });
  }

  // Forbid sensitive keys in metas
  const metaText = `${JSON.stringify(taskMeta)}\n${JSON.stringify(runMeta)}`;
  if (/cookie|api[_-]?key|authorization|notebook.*token/i.test(metaText)) {
    issues.push({ code: "SENSITIVE_META", message: "task/run meta 疑似包含敏感字段" });
  }

  for (const f of manifest.files) {
    const pathIssue = assertSafePackagePath(f.path);
    if (pathIssue) {
      issues.push(pathIssue);
      continue;
    }
    if (!f.path.startsWith("files/")) {
      issues.push({
        code: "FILE_PATH_PREFIX",
        message: `文件路径必须位于 files/ 下: ${f.path}`,
        path: f.path
      });
    }
    const buf = entries.get(f.path);
    if (!buf) {
      issues.push({ code: "FILE_MISSING", message: `包内缺少文件: ${f.path}`, path: f.path });
      continue;
    }
    if (buf.byteLength !== f.size_bytes) {
      issues.push({
        code: "SIZE_MISMATCH",
        message: `${f.path} size_bytes 不匹配`,
        path: f.path
      });
    }
    const digest = sha256Buffer(buf);
    if (digest.toLowerCase() !== f.sha256.toLowerCase()) {
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
      default_include:
        f.default_include ??
        (DEFAULT_INCLUDE_KINDS as string[]).includes(f.kind),
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
    "SENSITIVE_META",
    "FILE_PATH_PREFIX"
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

export { SCHEMA_VERSION, DEFAULT_INCLUDE_KINDS, DEFAULT_STRIP_KINDS };

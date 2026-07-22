import { createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  cpSync
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "..", "fixtures");

function sha256(buf: Buffer) {
  return createHash("sha256").update(buf).digest("hex");
}

function writeZipFromDir(dir: string, outZip: string) {
  rmSync(outZip, { force: true });
  // Use system zip for portability in fixture generation
  execFileSync("zip", ["-qr", outZip, "."], { cwd: dir });
}

function buildValid() {
  const dir = join(fixturesRoot, "valid-basic");
  const filesDir = join(dir, "files");
  const previewDir = join(dir, "preview");
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(previewDir, { recursive: true });

  const content = Buffer.from(
    "# Agent Eval Checklist\n\n- tasks\n- failure modes\n- regression\n",
    "utf8"
  );
  const pdf = Buffer.from("%PDF-1.4\n% Resource Gallery fixture slide\n", "utf8");
  const cover = Buffer.from(
    // minimal PNG 1x1
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );

  writeFileSync(join(filesDir, "checklist.md"), content);
  writeFileSync(join(filesDir, "deck.pdf"), pdf);
  writeFileSync(join(previewDir, "cover.png"), cover);

  const files = [
    {
      path: "files/deck.pdf",
      name: "deck.pdf",
      kind: "slide_pdf",
      sha256: sha256(pdf),
      size_bytes: pdf.byteLength,
      default_include: true
    },
    {
      path: "files/checklist.md",
      name: "checklist.md",
      kind: "content",
      sha256: sha256(content),
      size_bytes: content.byteLength,
      default_include: true
    }
  ];

  const manifest = {
    schema_version: "resource-gallery.export/v1",
    exported_at: "2026-07-19T12:00:00+08:00",
    generated_by: { product: "video2ppt", product_version: "fixture" },
    task_id: "task_fixture_001",
    run_id: "run_fixture_001",
    run_index: 1,
    title: "Agent 评测清单夹具",
    files,
    excluded_by_default_kinds: ["video", "subtitle"]
  };

  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(dir, "task_meta.json"),
    JSON.stringify(
      {
        task_id: "task_fixture_001",
        title: "Agent 评测清单夹具",
        source_platform_types: ["web"],
        language: "zh-CN"
      },
      null,
      2
    )
  );
  writeFileSync(
    join(dir, "run_meta.json"),
    JSON.stringify(
      {
        run_id: "run_fixture_001",
        run_index: 1,
        selected_source_count: 1,
        artifact_names: ["deck.pdf", "checklist.md"],
        completed_phases: ["parse", "generate"]
      },
      null,
      2
    )
  );

  const outZip = join(fixturesRoot, "valid-basic.zip");
  writeZipFromDir(dir, outZip);
  return outZip;
}

function buildValidVariant(
  sourceDir: string,
  name: string,
  taskId: string,
  runId: string,
  title: string,
  runIndex: number,
  includeCover = true,
  includeVideo = false
) {
  const dir = join(fixturesRoot, name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(sourceDir, dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const taskPath = join(dir, "task_meta.json");
  const runPath = join(dir, "run_meta.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const run = JSON.parse(readFileSync(runPath, "utf8"));
  if (!includeCover) rmSync(join(dir, "preview", "cover.png"), { force: true });
  Object.assign(manifest, { task_id: taskId, run_id: runId, run_index: runIndex, title });
  if (includeVideo) {
    const video = Buffer.from("FAKE-SOURCE-VIDEO");
    writeFileSync(join(dir, "files", "source.mp4"), video);
    manifest.files.push({
      path: "files/source.mp4",
      name: "source.mp4",
      kind: "video",
      sha256: sha256(video),
      size_bytes: video.byteLength,
      default_include: false
    });
  }
  Object.assign(task, { task_id: taskId, title });
  Object.assign(run, { run_id: runId, run_index: runIndex });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(taskPath, JSON.stringify(task, null, 2));
  writeFileSync(runPath, JSON.stringify(run, null, 2));
  const outZip = join(fixturesRoot, `${name}.zip`);
  writeZipFromDir(dir, outZip);
  return outZip;
}

function buildZipSlip() {
  const dir = join(fixturesRoot, "_tmp_zipslip");
  mkdirSync(join(dir, "files"), { recursive: true });
  const content = Buffer.from("x");
  writeFileSync(join(dir, "files", "ok.md"), content);
  const manifest = {
    schema_version: "resource-gallery.export/v1",
    exported_at: "2026-07-19T12:00:00+08:00",
    task_id: "t",
    run_id: "r",
    run_index: 0,
    title: "bad",
    files: [
      {
        path: "files/../evil.txt",
        name: "evil.txt",
        kind: "content",
        sha256: sha256(content),
        size_bytes: 1,
        default_include: true
      }
    ]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: "t", title: "bad" }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: "r", run_index: 0 }));
  // Create zip with an actual escaping path entry via zip -y and path
  const outZip = join(fixturesRoot, "invalid-zipslip.zip");
  rmSync(outZip, { force: true });
  execFileSync("zip", ["-qr", outZip, "manifest.json", "task_meta.json", "run_meta.json", "files"], {
    cwd: dir
  });
  // Append evil entry with parent path using zip
  writeFileSync(join(dir, "evil.txt"), content);
  try {
    execFileSync("zip", ["-q", outZip, "-P", "", "../evil.txt"], { cwd: join(dir, "files") });
  } catch {
    // fallback: package already has unsafe path in manifest; validator should fail on manifest path
  }
  rmSync(dir, { recursive: true, force: true });
  return outZip;
}

function buildAllVideo() {
  const dir = join(fixturesRoot, "_tmp_video");
  mkdirSync(join(dir, "files"), { recursive: true });
  const video = Buffer.from("FAKEVIDEO");
  writeFileSync(join(dir, "files", "clip.mp4"), video);
  const manifest = {
    schema_version: "resource-gallery.export/v1",
    exported_at: "2026-07-19T12:00:00+08:00",
    task_id: "tv",
    run_id: "rv",
    run_index: 1,
    title: "video only",
    files: [
      {
        path: "files/clip.mp4",
        name: "clip.mp4",
        kind: "video",
        sha256: sha256(video),
        size_bytes: video.byteLength,
        default_include: false
      }
    ]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: "tv", title: "video only" }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: "rv", run_index: 1 }));
  const outZip = join(fixturesRoot, "invalid-all-video.zip");
  writeZipFromDir(dir, outZip);
  rmSync(dir, { recursive: true, force: true });
  return outZip;
}

function buildBadSchema() {
  const dir = join(fixturesRoot, "_tmp_badschema");
  mkdirSync(join(dir, "files"), { recursive: true });
  const content = Buffer.from("hi");
  writeFileSync(join(dir, "files", "a.md"), content);
  const manifest = {
    schema_version: "resource-gallery.export/v0",
    exported_at: "2026-07-19T12:00:00+08:00",
    task_id: "t",
    run_id: "r",
    run_index: 1,
    title: "bad schema",
    files: [
      {
        path: "files/a.md",
        name: "a.md",
        kind: "content",
        sha256: sha256(content),
        size_bytes: 2
      }
    ]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: "t", title: "bad schema" }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: "r", run_index: 1 }));
  const outZip = join(fixturesRoot, "invalid-schema.zip");
  writeZipFromDir(dir, outZip);
  rmSync(dir, { recursive: true, force: true });
  return outZip;
}

buildValid();
const validSource = join(fixturesRoot, "valid-basic");
buildValidVariant(
  validSource,
  "valid-basic-update",
  "task_fixture_001",
  "run_fixture_001_update",
  "Agent 评测清单夹具（更新）",
  2,
  true
);
buildValidVariant(
  validSource,
  "valid-design",
  "task_fixture_002",
  "run_fixture_002",
  "设计评审方法夹具",
  2,
  false
);
buildValidVariant(
  validSource,
  "valid-product",
  "task_fixture_003",
  "run_fixture_003",
  "产品验证路线夹具",
  3,
  true,
  true
);
buildZipSlip();
buildAllVideo();
buildBadSchema();
console.log("fixtures built");

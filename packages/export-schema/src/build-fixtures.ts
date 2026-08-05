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
    excluded_by_default_kinds: ["auth"]
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
      default_include: true
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

function buildVideoOnly() {
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
        default_include: true
      }
    ]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: "tv", title: "video only" }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: "rv", run_index: 1 }));
  const outZip = join(fixturesRoot, "valid-video-only.zip");
  writeZipFromDir(dir, outZip);
  rmSync(dir, { recursive: true, force: true });
  return outZip;
}

function buildInvalidV1Overview() {
  const dir = join(fixturesRoot, "_tmp_v1_overview");
  mkdirSync(join(dir, "files"), { recursive: true });
  const audio = Buffer.from(
    "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",
    "base64"
  );
  writeFileSync(join(dir, "files", "overview.m4a"), audio);
  const manifest = {
    schema_version: "resource-gallery.export/v1",
    exported_at: "2026-08-05T12:00:00Z",
    task_id: "v1_overview",
    run_id: "v1_overview_run",
    run_index: 1,
    title: "invalid v1 overview",
    files: [{
      path: "files/overview.m4a",
      name: "overview.m4a",
      kind: "audio_overview",
      sha256: sha256(audio),
      size_bytes: audio.byteLength
    }]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: "v1_overview", title: "invalid" }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: "v1_overview_run", run_index: 1 }));
  const outZip = join(fixturesRoot, "invalid-v1-overview.zip");
  writeZipFromDir(dir, outZip);
  rmSync(dir, { recursive: true, force: true });
  return audio;
}

function buildV2MediaFixture(
  invalidParent = false,
  validAudio?: Buffer,
  invalidPreviewDistribution = false,
  invalidPreviewMedia = false
) {
  const dir = join(
    fixturesRoot,
    invalidParent ? "_tmp_v2_bad_parent" : invalidPreviewDistribution ? "_tmp_v2_bad_preview" : "_tmp_v2_media"
  );
  mkdirSync(join(dir, "files"), { recursive: true });
  mkdirSync(join(dir, "preview"), { recursive: true });
  const audio = validAudio ?? Buffer.from("FAKEAUDIO");
  const preview = invalidPreviewMedia ? Buffer.from("PREVIEWAUDIO") : audio;
  writeFileSync(join(dir, "files", "overview.m4a"), audio);
  writeFileSync(join(dir, "preview", "overview-preview.m4a"), preview);
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    generated_by: { product: "video2ppt", product_version: "fixture" },
    task_id: invalidParent ? "task_v2_bad_parent" : invalidPreviewMedia ? "task_v2_bad_preview_media" : "task_v2_media",
    run_id: invalidParent ? "run_v2_bad_parent" : invalidPreviewMedia ? "run_v2_bad_preview_media" : "run_v2_media",
    run_index: 1,
    title: "v2 media fixture",
    assets: [
      {
        id: "audio-main",
        path: "files/overview.m4a",
        name: "overview.m4a",
        kind: "audio_overview",
        sha256: sha256(audio),
        size_bytes: audio.byteLength,
        default_include: false,
        provenance: "generated_overview",
        variant_group_id: "audio-overview",
        media: { mime_type: "audio/mp4", duration_ms: 228, audio_codec: "aac", language: "zh" },
        distribution: { public_preview: "derived_only", entitlement_download: true }
      },
      {
        id: "audio-preview",
        path: "preview/overview-preview.m4a",
        name: "overview-preview.m4a",
        kind: "preview_audio",
        sha256: sha256(preview),
        size_bytes: preview.byteLength,
        default_include: false,
        provenance: "derived_preview",
        parent_file_id: invalidParent ? "missing-parent" : "audio-main",
        media: { mime_type: "audio/mp4", duration_ms: invalidPreviewMedia ? 300 : 228, audio_codec: "aac", language: "zh" },
        distribution: {
          public_preview: invalidPreviewDistribution ? "none" : "derived_only",
          entitlement_download: invalidPreviewDistribution
        }
      }
    ]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: 1 }));
  const outZip = join(
    fixturesRoot,
    invalidParent
      ? "invalid-v2-parent.zip"
      : invalidPreviewDistribution
        ? "invalid-v2-preview-distribution.zip"
        : invalidPreviewMedia
          ? "invalid-v2-preview-media.zip"
          : "valid-v2-media.zip"
  );
  writeZipFromDir(dir, outZip);
  rmSync(dir, { recursive: true, force: true });
}

function buildV2ZeroMediaFixture() {
  const name = "invalid-v2-zero-media";
  const dir = join(fixturesRoot, `_tmp_${name}`);
  mkdirSync(join(dir, "files"), { recursive: true });
  const empty = Buffer.alloc(0);
  writeFileSync(join(dir, "files", "empty.m4a"), empty);
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    generated_by: { product: "video2ppt", product_version: "fixture" },
    task_id: "task_v2_zero_media",
    run_id: "run_v2_zero_media",
    run_index: 1,
    title: "invalid v2 zero media fixture",
    assets: [{
      id: "audio-empty",
      path: "files/empty.m4a",
      name: "empty.m4a",
      kind: "audio_overview",
      sha256: sha256(empty),
      size_bytes: 0,
      default_include: false,
      provenance: "generated_overview",
      variant_group_id: "audio-overview",
      media: { mime_type: "audio/mp4", duration_ms: 1, audio_codec: "aac", language: "zh" },
      distribution: { public_preview: "derived_only", entitlement_download: true }
    }]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: 1 }));
  writeZipFromDir(dir, join(fixturesRoot, `${name}.zip`));
  rmSync(dir, { recursive: true, force: true });
}

function buildV2VariantMediaFixture(audio: Buffer) {
  const name = "valid-v2-variant-media";
  const dir = join(fixturesRoot, `_tmp_${name}`);
  mkdirSync(join(dir, "files"), { recursive: true });
  const variants = [
    { id: "audio-zh", filename: "overview-zh.m4a", group: "audio-zh", language: "zh" },
    { id: "audio-en", filename: "overview-en.m4a", group: "audio-en", language: "en" }
  ];
  for (const variant of variants) writeFileSync(join(dir, "files", variant.filename), audio);
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    generated_by: { product: "video2ppt", product_version: "fixture" },
    task_id: "task_v2_variant_media",
    run_id: "run_v2_variant_media",
    run_index: 1,
    title: "v2 variant media fixture",
    assets: variants.map((variant) => ({
      id: variant.id,
      path: `files/${variant.filename}`,
      name: variant.filename,
      kind: "audio_overview",
      sha256: sha256(audio),
      size_bytes: audio.byteLength,
      default_include: false,
      provenance: "generated_overview",
      variant_group_id: variant.group,
      media: { mime_type: "audio/mp4", duration_ms: 228, audio_codec: "aac", language: variant.language },
      distribution: { public_preview: "derived_only", entitlement_download: true }
    }))
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: 1 }));
  writeZipFromDir(dir, join(fixturesRoot, `${name}.zip`));
  rmSync(dir, { recursive: true, force: true });
}

function buildV2CoreFixture(name = "valid-v2-core", taskId = "task_v2_core", defaultInclude = true) {
  const dir = join(fixturesRoot, `_tmp_${name}`);
  mkdirSync(join(dir, "files"), { recursive: true });
  const content = Buffer.from("# v2 core resource\n", "utf8");
  writeFileSync(join(dir, "files", "resource.md"), content);
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    task_id: taskId,
    run_id: `run_${taskId.replace(/^task_/, "")}`,
    run_index: 1,
    title: "v2 core fixture",
    assets: [{
      id: "core-resource",
      path: "files/resource.md",
      name: "resource.md",
      kind: "content",
      sha256: sha256(content),
      size_bytes: content.byteLength,
      default_include: defaultInclude,
      provenance: "pipeline"
    }]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: 1 }));
  const outZip = join(fixturesRoot, `${name}.zip`);
  writeZipFromDir(dir, outZip);
  rmSync(dir, { recursive: true, force: true });
}

function buildV2UndeclaredEntryFixture() {
  const name = "invalid-v2-undeclared-entry";
  const dir = join(fixturesRoot, `_tmp_${name}`);
  mkdirSync(join(dir, "files"), { recursive: true });
  const resource = Buffer.from("# declared resource\n", "utf8");
  writeFileSync(join(dir, "files", "resource.md"), resource);
  writeFileSync(join(dir, "files", "unexpected.txt"), "must not be ignored\n");
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    task_id: "task_v2_undeclared_entry",
    run_id: "run_v2_undeclared_entry",
    run_index: 1,
    title: "invalid v2 undeclared entry fixture",
    assets: [{
      id: "declared-resource",
      path: "files/resource.md",
      name: "resource.md",
      kind: "content",
      sha256: sha256(resource),
      size_bytes: resource.byteLength,
      default_include: true
    }]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: manifest.run_index }));
  writeZipFromDir(dir, join(fixturesRoot, `${name}.zip`));
  rmSync(dir, { recursive: true, force: true });
}

function buildAmbiguousV2MediaFixture(audio: Buffer) {
  const name = "invalid-v2-ambiguous-media";
  const dir = join(fixturesRoot, `_tmp_${name}`);
  mkdirSync(join(dir, "files"), { recursive: true });
  writeFileSync(join(dir, "files", "overview-a.m4a"), audio);
  writeFileSync(join(dir, "files", "overview-b.m4a"), audio);
  const asset = (id: string, filename: string) => ({
    id,
    path: `files/${filename}`,
    name: filename,
    kind: "audio_overview",
    sha256: sha256(audio),
    size_bytes: audio.byteLength,
    default_include: false,
    provenance: "generated_overview",
    variant_group_id: "audio-overview",
    media: { mime_type: "audio/mp4", duration_ms: 228, audio_codec: "aac", language: "zh" },
    distribution: { public_preview: "derived_only", entitlement_download: true }
  });
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    task_id: "task_v2_ambiguous_media",
    run_id: "run_v2_ambiguous_media",
    run_index: 1,
    title: "ambiguous v2 media fixture",
    assets: [asset("audio-a", "overview-a.m4a"), asset("audio-b", "overview-b.m4a")]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: 1 }));
  writeZipFromDir(dir, join(fixturesRoot, `${name}.zip`));
  rmSync(dir, { recursive: true, force: true });
}

function buildV2DuplicateAssetFixture(duplicatePath: boolean, duplicateFilename = false) {
  const name = duplicateFilename
    ? "invalid-v2-filename-collision"
    : duplicatePath
      ? "invalid-v2-duplicate-path"
      : "invalid-v2-duplicate-id";
  const dir = join(fixturesRoot, `_tmp_${name}`);
  mkdirSync(join(dir, "files"), { recursive: true });
  const first = Buffer.from("first asset\n", "utf8");
  const second = Buffer.from("second asset\n", "utf8");
  writeFileSync(join(dir, "files", "first.md"), first);
  if (!duplicatePath) writeFileSync(join(dir, "files", "second.md"), second);
  const secondPath = duplicatePath ? "files/first.md" : "files/second.md";
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    task_id: `task_${name}`,
    run_id: `run_${name}`,
    run_index: 1,
    title: "invalid v2 duplicate asset fixture",
    assets: [
      {
        id: "duplicate-asset",
        path: "files/first.md",
        name: duplicateFilename ? "Cafe\u0301.md" : "first.md",
        kind: "content",
        sha256: sha256(first),
        size_bytes: first.byteLength,
        default_include: true
      },
      {
        id: duplicatePath || duplicateFilename ? "second-asset" : "duplicate-asset",
        path: secondPath,
        name: duplicatePath ? "first.md" : duplicateFilename ? "CAFÉ.md" : "second.md",
        kind: "content",
        sha256: duplicatePath ? sha256(first) : sha256(second),
        size_bytes: duplicatePath ? first.byteLength : second.byteLength,
        default_include: true
      }
    ]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: 1 }));
  writeZipFromDir(dir, join(fixturesRoot, `${name}.zip`));
  rmSync(dir, { recursive: true, force: true });
}

function buildV2ForbiddenAssetFixture(
  name: string,
  kind: "auth" | "content" | "subtitle",
  filename: string,
  defaultInclude = false
) {
  const dir = join(fixturesRoot, `_tmp_${name}`);
  mkdirSync(join(dir, "files"), { recursive: true });
  const content = Buffer.from("fixture-only", "utf8");
  writeFileSync(join(dir, "files", filename), content);
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    task_id: `task_${name}`,
    run_id: `run_${name}`,
    run_index: 1,
    title: "invalid v2 asset fixture",
    assets: [{
      id: "invalid-asset",
      path: `files/${filename}`,
      name: filename,
      kind,
      sha256: sha256(content),
      size_bytes: content.byteLength,
      default_include: defaultInclude
    }]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: 1 }));
  writeZipFromDir(dir, join(fixturesRoot, `${name}.zip`));
  rmSync(dir, { recursive: true, force: true });
}

function buildV2SensitiveReferenceFixture(name: string, taskMetaExtra: Record<string, unknown>, assetName = "resource.md") {
  const dir = join(fixturesRoot, `_tmp_${name}`);
  mkdirSync(join(dir, "files"), { recursive: true });
  const content = Buffer.from("fixture-only", "utf8");
  writeFileSync(join(dir, "files", "resource.md"), content);
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    task_id: `task_${name}`,
    run_id: `run_${name}`,
    run_index: 1,
    title: "invalid v2 sensitive reference fixture",
    assets: [{
      id: "reference-asset",
      path: "files/resource.md",
      name: assetName,
      kind: "content",
      sha256: sha256(content),
      size_bytes: content.byteLength,
      default_include: true
    }]
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title, ...taskMetaExtra }));
  writeFileSync(join(dir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: 1 }));
  writeZipFromDir(dir, join(fixturesRoot, `${name}.zip`));
  rmSync(dir, { recursive: true, force: true });
}

function buildV2SensitiveMetaFixture() {
  buildV2SensitiveReferenceFixture("invalid-v2-password", { password: "not-for-export" });
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
buildVideoOnly();
const validV2Audio = buildInvalidV1Overview();
buildV2MediaFixture(false, validV2Audio);
buildV2VariantMediaFixture(validV2Audio);
buildV2MediaFixture(true);
buildV2MediaFixture(false, undefined, true);
buildV2MediaFixture(false, validV2Audio, false, true);
buildV2ZeroMediaFixture();
buildV2CoreFixture();
buildV2CoreFixture("valid-v2-sync-core", "task_v2_sync_core");
buildV2CoreFixture("valid-v2-gated-core", "task_v2_gated_core", false);
buildV2UndeclaredEntryFixture();
buildAmbiguousV2MediaFixture(validV2Audio);
buildV2DuplicateAssetFixture(false);
buildV2DuplicateAssetFixture(true);
buildV2DuplicateAssetFixture(false, true);
buildV2ForbiddenAssetFixture("invalid-v2-auth", "auth", "credentials.json");
buildV2ForbiddenAssetFixture("invalid-v2-sensitive-name", "content", "api-token.md");
buildV2ForbiddenAssetFixture("invalid-v2-subtitle-default", "subtitle", "overview.srt", true);
buildV2SensitiveReferenceFixture("invalid-v2-source-url", { source_url: "https://example.com/private-source" });
buildV2SensitiveReferenceFixture("invalid-v2-local-path", {}, "/Users/operator/private-note.md");
buildV2SensitiveMetaFixture();
buildBadSchema();
console.log("fixtures built");

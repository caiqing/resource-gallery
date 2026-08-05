import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

process.env.SESSION_SECRET ??= randomBytes(32).toString("hex");
process.env.DOWNLOAD_SIGNING_SECRET ??= randomBytes(32).toString("hex");
const { makeDownloadToken, verifyDownloadToken } = await import("./lib/crypto.js");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fixtureRoot = join(root, "../../packages/export-schema/fixtures");
const fixtures = ["valid-basic.zip", "valid-design.zip", "valid-product.zip"].map((name) =>
  join(fixtureRoot, name)
);
const taskUpdateFixture = join(fixtureRoot, "valid-basic-update.zip");
const invalidFixture = join(fixtureRoot, "invalid-schema.zip");
const v2CoreFixture = join(fixtureRoot, "valid-v2-core.zip");
const v2SyncCoreFixture = join(fixtureRoot, "valid-v2-sync-core.zip");
const v2GatedCoreFixture = join(fixtureRoot, "valid-v2-gated-core.zip");
const v2MediaFixture = join(fixtureRoot, "valid-v2-media.zip");
const v2MediaUpdateFixture = join(root, "data/smoke-v2-media-update.zip");
const v2MediaUpdateFixtureDir = join(root, "data/smoke-v2-media-update");
const v2MediaMismatchFixture = join(root, "data/smoke-v2-media-mismatch.zip");
const v2MediaMismatchFixtureDir = join(root, "data/smoke-v2-media-mismatch");
const v2FullMediaLimitFixture = join(root, "data/smoke-v2-full-media-limit.zip");
const v2FullMediaLimitFixtureDir = join(root, "data/smoke-v2-full-media-limit");
const v2VideoFixture = join(root, "data/smoke-v2-video.zip");
const v2VideoFixtureDir = join(root, "data/smoke-v2-video");
const v2PreviewLimitFixture = join(root, "data/smoke-v2-preview-limit.zip");
const v2PreviewLimitFixtureDir = join(root, "data/smoke-v2-preview-limit");
const invalidV2PreviewMediaFixture = join(fixtureRoot, "invalid-v2-preview-media.zip");
const invalidV2SafetyFixtures = [
  "invalid-v2-auth.zip",
  "invalid-v2-sensitive-name.zip",
  "invalid-v2-subtitle-default.zip",
  "invalid-v2-source-url.zip",
  "invalid-v2-local-path.zip",
  "invalid-v2-password.zip",
  "invalid-v2-undeclared-entry.zip"
].map((name) => join(fixtureRoot, name));
const seedAdminEmail = "smoke-admin@gallery.local";
const seedAdminPassword = randomBytes(24).toString("hex");
const syncToken = randomBytes(32).toString("hex");
const seedUserEmail = "smoke-user@gallery.local";
const seedUserPassword = randomBytes(24).toString("hex");

type Client = { cookie: string };

function mediaMetadata(path: string) {
  const payload = JSON.parse(execFileSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { encoding: "utf8" }
  ));
  const audio = payload.streams.find((stream: any) => stream.codec_type === "audio");
  const video = payload.streams.find((stream: any) => stream.codec_type === "video");
  return {
    mime_type: "video/mp4",
    duration_ms: Math.round(Number(payload.format.duration) * 1000),
    width: Number(video.width),
    height: Number(video.height),
    audio_codec: String(audio.codec_name),
    video_codec: String(video.codec_name),
    language: "zh"
  };
}

function fixtureAsset(id: string, path: string, name: string, kind: string, parent_file_id?: string) {
  const content = readFileSync(join(v2VideoFixtureDir, path));
  const asset: Record<string, unknown> = {
    id,
    path,
    name,
    kind,
    sha256: createHash("sha256").update(content).digest("hex"),
    size_bytes: content.byteLength,
    default_include: false,
    provenance: kind === "video_overview" ? "generated_overview" : "derived_preview",
    parent_file_id: parent_file_id ?? null,
    distribution: {
      public_preview: "derived_only",
      entitlement_download: kind === "video_overview"
    }
  };
  if (kind !== "poster") asset.media = mediaMetadata(join(v2VideoFixtureDir, path));
  return asset;
}

function buildVideoFixture() {
  rmSync(v2VideoFixtureDir, { recursive: true, force: true });
  rmSync(v2VideoFixture, { force: true });
  mkdirSync(join(v2VideoFixtureDir, "files"), { recursive: true });
  mkdirSync(join(v2VideoFixtureDir, "preview"), { recursive: true });
  const full = join(v2VideoFixtureDir, "files/overview.mp4");
  const preview = join(v2VideoFixtureDir, "preview/overview-preview.mp4");
  const poster = join(v2VideoFixtureDir, "preview/overview-poster.png");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=32x18:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "32k", "-shortest", full
  ]);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", full,
    "-t", "0.25", "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k", preview
  ]);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-ss", "0", "-i", full,
    "-frames:v", "1", poster
  ]);
  const main = fixtureAsset("video-main", "files/overview.mp4", "overview.mp4", "video_overview");
  const previewAsset = fixtureAsset("video-preview", "preview/overview-preview.mp4", "overview-preview.mp4", "preview_video", "video-main");
  const posterAsset = fixtureAsset("video-poster", "preview/overview-poster.png", "overview-poster.png", "poster", "video-main");
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    task_id: "task_v2_video",
    run_id: "run_v2_video",
    run_index: 1,
    title: "v2 video fixture",
    assets: [main, previewAsset, posterAsset]
  };
  writeFileSync(join(v2VideoFixtureDir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(v2VideoFixtureDir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title }));
  writeFileSync(join(v2VideoFixtureDir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: manifest.run_index }));
  execFileSync("zip", ["-qr", v2VideoFixture, "."], { cwd: v2VideoFixtureDir });
  return { main, previewAsset };
}

function buildPreviewLimitFixture(main: Record<string, unknown>, previewAsset: Record<string, unknown>) {
  rmSync(v2PreviewLimitFixtureDir, { recursive: true, force: true });
  rmSync(v2PreviewLimitFixture, { force: true });
  mkdirSync(join(v2PreviewLimitFixtureDir, "files"), { recursive: true });
  mkdirSync(join(v2PreviewLimitFixtureDir, "preview"), { recursive: true });
  writeFileSync(
    join(v2PreviewLimitFixtureDir, "files/overview.mp4"),
    readFileSync(join(v2VideoFixtureDir, "files/overview.mp4"))
  );
  const oversizedPath = "preview/oversized.mp4";
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  writeFileSync(join(v2PreviewLimitFixtureDir, oversizedPath), oversized);
  const oversizedPreview = {
    ...previewAsset,
    id: "video-preview-oversized",
    path: oversizedPath,
    name: "oversized-preview.mp4",
    sha256: createHash("sha256").update(oversized).digest("hex"),
    size_bytes: oversized.byteLength
  };
  const manifest = {
    schema_version: "resource-gallery.export/v2",
    exported_at: "2026-08-05T12:00:00Z",
    task_id: "task_v2_preview_limit",
    run_id: "run_v2_preview_limit",
    run_index: 1,
    title: "v2 preview limit fixture",
    assets: [main, oversizedPreview]
  };
  writeFileSync(join(v2PreviewLimitFixtureDir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(v2PreviewLimitFixtureDir, "task_meta.json"), JSON.stringify({ task_id: manifest.task_id, title: manifest.title }));
  writeFileSync(join(v2PreviewLimitFixtureDir, "run_meta.json"), JSON.stringify({ run_id: manifest.run_id, run_index: manifest.run_index }));
  execFileSync("zip", ["-qr", v2PreviewLimitFixture, "."], { cwd: v2PreviewLimitFixtureDir });
}

function buildV2MediaUpdateFixture() {
  rmSync(v2MediaUpdateFixture, { force: true });
  rmSync(v2MediaUpdateFixtureDir, { recursive: true, force: true });
  mkdirSync(v2MediaUpdateFixtureDir, { recursive: true });
  execFileSync("unzip", ["-q", v2MediaFixture, "-d", v2MediaUpdateFixtureDir]);
  const manifestPath = join(v2MediaUpdateFixtureDir, "manifest.json");
  const taskMetaPath = join(v2MediaUpdateFixtureDir, "task_meta.json");
  const runMetaPath = join(v2MediaUpdateFixtureDir, "run_meta.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const taskMeta = JSON.parse(readFileSync(taskMetaPath, "utf8"));
  const runMeta = JSON.parse(readFileSync(runMetaPath, "utf8"));
  manifest.title = "v2 media fixture metadata update";
  taskMeta.title = manifest.title;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(taskMetaPath, JSON.stringify(taskMeta));
  writeFileSync(runMetaPath, JSON.stringify(runMeta));
  execFileSync("zip", ["-qr", v2MediaUpdateFixture, "."], { cwd: v2MediaUpdateFixtureDir });
}

function buildV2MediaMismatchFixture() {
  rmSync(v2MediaMismatchFixture, { force: true });
  rmSync(v2MediaMismatchFixtureDir, { recursive: true, force: true });
  mkdirSync(v2MediaMismatchFixtureDir, { recursive: true });
  execFileSync("unzip", ["-q", v2MediaFixture, "-d", v2MediaMismatchFixtureDir]);
  const manifestPath = join(v2MediaMismatchFixtureDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const full = manifest.assets.find((asset: any) => asset.kind === "audio_overview");
  full.media.duration_ms += 1;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  execFileSync("zip", ["-qr", v2MediaMismatchFixture, "."], { cwd: v2MediaMismatchFixtureDir });
}

function buildV2FullMediaLimitFixture() {
  rmSync(v2FullMediaLimitFixture, { force: true });
  rmSync(v2FullMediaLimitFixtureDir, { recursive: true, force: true });
  mkdirSync(v2FullMediaLimitFixtureDir, { recursive: true });
  execFileSync("unzip", ["-q", v2MediaFixture, "-d", v2FullMediaLimitFixtureDir]);
  const fullPath = join(v2FullMediaLimitFixtureDir, "files/overview.m4a");
  const oversized = Buffer.alloc(64 * 1024 * 1024 + 1);
  writeFileSync(fullPath, oversized);
  const manifestPath = join(v2FullMediaLimitFixtureDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const full = manifest.assets.find((asset: any) => asset.kind === "audio_overview");
  full.sha256 = createHash("sha256").update(oversized).digest("hex");
  full.size_bytes = oversized.byteLength;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  execFileSync("zip", ["-qr", v2FullMediaLimitFixture, "."], { cwd: v2FullMediaLimitFixtureDir });
}

async function waitHealth(port: number, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Server startup is retried for a bounded interval.
    }
    await sleep(200);
  }
  throw new Error("api not healthy");
}

describe("M0-M4 acceptance smoke", () => {
  let child: ChildProcess | undefined;
  let modelServer: Server | undefined;
  const port = 8799;
  const modelPort = 8798;
  const dbPath = join(root, "data/smoke.db");
  const blobRoot = join(root, "data/smoke-blobs");
  const uploadRoot = join(root, "data/smoke-uploads");
  const configEnvPath = join(root, "data/smoke.env");
  const anonymous: Client = { cookie: "" };
  const admin: Client = { cookie: "" };
  const user: Client = { cookie: "" };
  const secondUser: Client = { cookie: "" };
  const listingIds: string[] = [];
  let firstShareSlug = "";

  before(async () => {
    for (const fixture of [...fixtures, taskUpdateFixture, invalidFixture, v2CoreFixture, v2SyncCoreFixture, v2GatedCoreFixture, v2MediaFixture, invalidV2PreviewMediaFixture, ...invalidV2SafetyFixtures]) {
      if (!existsSync(fixture)) throw new Error(`missing fixture ${fixture}; build fixtures first`);
    }
    const { main, previewAsset } = buildVideoFixture();
    buildPreviewLimitFixture(main, previewAsset);
    buildV2MediaMismatchFixture();
    buildV2FullMediaLimitFixture();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(blobRoot, { recursive: true, force: true });
    rmSync(uploadRoot, { recursive: true, force: true });
    rmSync(configEnvPath, { force: true });
    modelServer = createServer((request, response) => {
      if (request.url !== "/v1/models" || request.headers.authorization !== "Bearer pending-model-key") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: [
          { id: "summary-primary", name: "Summary Primary", owned_by: "smoke" },
          { id: "summary-backup", name: "Summary Backup", owned_by: "smoke" }
        ]
      }));
    });
    await new Promise<void>((resolve, reject) => {
      modelServer?.once("error", reject);
      modelServer?.listen(modelPort, "127.0.0.1", resolve);
    });
    child = spawn(process.execPath, ["--import", "tsx", join(here, "index.ts")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_PATH: "./data/smoke.db",
        BLOB_ROOT: "./data/smoke-blobs",
        UPLOAD_ROOT: "./data/smoke-uploads",
        CONFIG_ENV_PATH: "./data/smoke.env",
        SESSION_SECRET: randomBytes(32).toString("hex"),
        DOWNLOAD_SIGNING_SECRET: randomBytes(32).toString("hex"),
        SEED_USERS: "true",
        SEED_TEST_USER: "true",
        SEED_ADMIN_EMAIL: seedAdminEmail,
        SEED_ADMIN_PASSWORD: seedAdminPassword,
        SEED_USER_EMAIL: seedUserEmail,
        SEED_USER_PASSWORD: seedUserPassword,
        RESOURCE_GALLERY_SYNC_ENABLED: "true",
        RESOURCE_GALLERY_SYNC_TOKEN: syncToken,
        RESOURCE_GALLERY_SYNC_ACTOR_EMAIL: seedAdminEmail,
        MAX_PREVIEW_BYTES: String(10 * 1024 * 1024),
        CORS_ORIGIN: "http://127.0.0.1:5173",
        WEB_ORIGIN: "http://127.0.0.1:5173",
        SUMMARY_LLM_ENABLED: "1",
        SUMMARY_LLM_PROVIDER: "openai-compatible",
        SUMMARY_LLM_BASE_URL: "https://llm.example.test/v1",
        SUMMARY_LLM_API_KEY: "",
        SUMMARY_LLM_MODEL: "summary-model",
        SUMMARY_LLM_FALLBACK_MODELS: "fallback-a,fallback-b"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitHealth(port);
  });

  after(() => {
    child?.kill("SIGTERM");
    modelServer?.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(blobRoot, { recursive: true, force: true });
    rmSync(uploadRoot, { recursive: true, force: true });
    rmSync(configEnvPath, { force: true });
    rmSync(v2VideoFixture, { force: true });
    rmSync(v2VideoFixtureDir, { recursive: true, force: true });
    rmSync(v2PreviewLimitFixture, { force: true });
    rmSync(v2PreviewLimitFixtureDir, { recursive: true, force: true });
    rmSync(v2MediaUpdateFixture, { force: true });
    rmSync(v2MediaUpdateFixtureDir, { recursive: true, force: true });
    rmSync(v2MediaMismatchFixture, { force: true });
    rmSync(v2MediaMismatchFixtureDir, { recursive: true, force: true });
    rmSync(v2FullMediaLimitFixture, { force: true });
    rmSync(v2FullMediaLimitFixtureDir, { recursive: true, force: true });
  });

  async function api(client: Client, path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (client.cookie) headers.set("cookie", client.cookie);
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const match = cookie.match(/^rg_session=[^;]+/);
      if (match) client.cookie = match[0];
    }
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  async function login(client: Client, email: string, password: string) {
    const result = await api(client, "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
  }

  async function importFixture(path: string) {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(path)]), path.split("/").at(-1));
    return api(admin, "/api/admin/import-jobs", { method: "POST", body: form });
  }

  it("serves health and rejects anonymous member/admin operations", async () => {
    const health = await api(anonymous, "/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.data.ok, true);
    assert.equal((await api(anonymous, "/api/me/likes")).response.status, 401);
    assert.equal((await api(anonymous, "/api/admin/listings")).response.status, 401);
    assert.equal((await api(anonymous, "/api/admin/llm/settings")).response.status, 401);
    assert.equal(
      (await api(anonymous, "/api/admin/listings/publish-all", { method: "POST" })).response.status,
      401
    );
  });

  it("enforces the registered-user 403 matrix", async () => {
    await login(user, seedUserEmail, seedUserPassword);
    const form = new FormData();
    form.append("file", new Blob([readFileSync(fixtures[0])]), "valid-basic.zip");
    assert.equal(
      (await api(user, "/api/admin/import-jobs", { method: "POST", body: form })).response.status,
      403
    );
    assert.equal(
      (await api(user, "/api/admin/listings/not-real/publish", { method: "POST" })).response.status,
      403
    );
    assert.equal(
      (await api(user, "/api/admin/listings/publish-all", { method: "POST" })).response.status,
      403
    );
    assert.equal((await api(user, "/api/admin/llm/settings")).response.status, 403);
  });

  it("supports machine sync review, idempotency, and auto-publish", async () => {
    const headers = {
      Authorization: `Bearer ${syncToken}`,
      "X-Resource-Gallery-Publish-Policy": "review"
    };
    const run = await fetch(`http://127.0.0.1:${port}/api/sync/runs`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ publish_policy: "review", source: "smoke" })
    });
    const runBody = await run.json();
    assert.equal(run.status, 201, JSON.stringify(runBody));
    const runData = runBody as { run_id: string };
    const form = new FormData();
    form.append("file", new Blob([readFileSync(v2SyncCoreFixture)]), "valid-v2-sync-core.zip");
    const imported = await fetch(`http://127.0.0.1:${port}/api/sync/packages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "X-Resource-Gallery-Publish-Policy": "review",
        "X-Resource-Gallery-Sync-Run-Id": runData.run_id,
        "X-Resource-Gallery-Task-Id": "task_v2_sync_core"
      },
      body: form
    });
    const importedData = await imported.json();
    assert.equal(imported.status, 200, JSON.stringify(importedData));
    assert.equal(importedData.status, "review");
    const state = await fetch(`http://127.0.0.1:${port}/api/sync/states/task_v2_sync_core`, { headers });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).state.status, "review");

    const mismatchedForm = new FormData();
    mismatchedForm.append("file", new Blob([readFileSync(v2SyncCoreFixture)]), "valid-v2-sync-core.zip");
    const mismatched = await fetch(`http://127.0.0.1:${port}/api/sync/packages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "X-Resource-Gallery-Publish-Policy": "review",
        "X-Resource-Gallery-Task-Id": "task_v2_sync_mismatch",
        "X-Resource-Gallery-Track-State": "false"
      },
      body: mismatchedForm
    });
    const mismatchedData = await mismatched.json();
    assert.equal(mismatched.status, 422, JSON.stringify(mismatchedData));
    assert.equal(mismatchedData.error_code, "SYNC_TASK_ID_MISMATCH");
    assert.match(mismatchedData.job.message, /^SYNC_TASK_ID_MISMATCH:/);

    const ephemeralForm = new FormData();
    ephemeralForm.append("file", new Blob([readFileSync(v2SyncCoreFixture)]), "valid-v2-sync-core.zip");
    const ephemeral = await fetch(`http://127.0.0.1:${port}/api/sync/packages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "X-Resource-Gallery-Publish-Policy": "review",
        "X-Resource-Gallery-Sync-Run-Id": runData.run_id,
        "X-Resource-Gallery-Task-Id": "task_v2_sync_core",
        "X-Resource-Gallery-Track-State": "false"
      },
      body: ephemeralForm
    });
    const ephemeralData = await ephemeral.json();
    assert.equal(ephemeral.status, 200, JSON.stringify(ephemeralData));
    assert.equal(ephemeralData.state_tracked, false);
    const ephemeralState = await fetch(`http://127.0.0.1:${port}/api/sync/states/task_v2_sync_ephemeral`, { headers });
    assert.equal(ephemeralState.status, 404);

    const autoRun = await fetch(`http://127.0.0.1:${port}/api/sync/runs`, {
      method: "POST",
      headers: { ...headers, "X-Resource-Gallery-Publish-Policy": "auto_publish", "Content-Type": "application/json" },
      body: JSON.stringify({ publish_policy: "auto_publish", source: "smoke" })
    });
    const autoRunData = await autoRun.json() as { run_id: string };
    const autoForm = new FormData();
    autoForm.append("file", new Blob([readFileSync(v2SyncCoreFixture)]), "valid-v2-sync-core.zip");
    const auto = await fetch(`http://127.0.0.1:${port}/api/sync/packages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "X-Resource-Gallery-Publish-Policy": "auto_publish",
        "X-Resource-Gallery-Sync-Run-Id": autoRunData.run_id,
        "X-Resource-Gallery-Task-Id": "task_v2_sync_core"
      },
      body: autoForm
    });
    const autoData = await auto.json();
    assert.equal(auto.status, 200, JSON.stringify(autoData));
    assert.equal(autoData.status, "published", JSON.stringify(autoData));
    const published = await api(anonymous, "/api/listings/" + autoData.job.listing_id);
    assert.equal(published.data.listing.status, "published");

    const gatedForm = new FormData();
    gatedForm.append("file", new Blob([readFileSync(v2GatedCoreFixture)]), "valid-v2-gated-core.zip");
    const gated = await fetch(`http://127.0.0.1:${port}/api/sync/packages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${syncToken}`,
        "X-Resource-Gallery-Publish-Policy": "auto_publish",
        "X-Resource-Gallery-Sync-Run-Id": autoRunData.run_id,
        "X-Resource-Gallery-Task-Id": "task_v2_gated_core"
      },
      body: gatedForm
    });
    const gatedData = await gated.json();
    assert.equal(gated.status, 200, JSON.stringify(gatedData));
    assert.equal(gatedData.status, "review");
    assert.equal(gatedData.gate.code, "NO_INCLUDED_ASSETS");

    const metrics = await fetch(`http://127.0.0.1:${port}/api/sync/metrics`, { headers });
    assert.equal(metrics.status, 200);
    const metricText = await metrics.text();
    assert.match(metricText, /resource_gallery_sync_states_total\{status="review"\}/);
    assert.match(metricText, /resource_gallery_sync_review_oldest_age_seconds \d+/);
    assert.match(metricText, /resource_gallery_sync_gate_reviews_total 1/);

    const metricsDb = new DatabaseSync(dbPath);
    metricsDb.prepare(
      `UPDATE resource_sync_states SET updated_at = '2000-01-01T00:00:00.000Z' WHERE source_task_id = ?`
    ).run("task_v2_gated_core");
    metricsDb.close();
    const staleMetrics = await fetch(`http://127.0.0.1:${port}/api/sync/metrics`, { headers });
    assert.match(
      await staleMetrics.text(),
      /resource_gallery_sync_review_oldest_age_seconds [1-9]\d{6,}/
    );

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/sync/states/task_v2_sync_core`);
    assert.equal(unauthorized.status, 401);
  });

  it("imports and publishes three independent v1 packages", async () => {
    await login(admin, seedAdminEmail, seedAdminPassword);
    for (const fixture of fixtures) {
      const imported = await importFixture(fixture);
      assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
      assert.equal(imported.data.job.status, "succeeded", JSON.stringify(imported.data));
      const listingId = String(imported.data.job.listing_id);
      listingIds.push(listingId);
      if (fixture.endsWith("valid-basic.zip")) {
        const curatedTitle = "Agent 评测清单夹具-策展保留";
        const curatedSummary = "Agent 评测清单夹具-策展摘要保留";
        const beforeUpdate = await api(admin, `/api/admin/listings/${listingId}`);
        const excludeId = String(beforeUpdate.data.files.find((file: any) => file.kind === "content")?.id || "");
        assert.ok(excludeId, "expected content file before update");
        const patched = await api(admin, `/api/admin/listings/${listingId}`, {
          method: "PATCH",
          body: JSON.stringify({
            title: curatedTitle,
            summary: curatedSummary,
            tags: ["策展标签", "保留标签"],
            topic_id: "ai-eng",
            included_file_ids: beforeUpdate.data.files
              .filter((file: any) => file.stripped !== 1 && file.id !== excludeId)
              .map((file: any) => file.id)
          })
        });
        assert.equal(patched.response.status, 200, JSON.stringify(patched.data));

        const updated = await importFixture(taskUpdateFixture);
        assert.equal(updated.data.job.status, "succeeded", JSON.stringify(updated.data));
        assert.equal(updated.data.job.listing_id, listingId);
        const updatedListing = await api(admin, `/api/admin/listings/${listingId}`);
        assert.equal(updatedListing.data.listing.source_run_id, "run_fixture_001_update");
        assert.equal(updatedListing.data.listing.title, curatedTitle);
        assert.equal(updatedListing.data.listing.summary, curatedSummary);
        assert.equal(updatedListing.data.listing.summary_origin, "operator");
        assert.equal(updatedListing.data.listing.summary_locked, 1);
        assert.deepEqual(
          updatedListing.data.tags.map((tag: any) => tag.tag).sort(),
          ["保留标签", "策展标签"]
        );
        const excludedAgain = updatedListing.data.files.find((file: any) => file.kind === "content");
        assert.ok(excludedAgain, "content file should still exist after package refresh");
        assert.equal(excludedAgain.included, 0);
      }
      if (fixture.endsWith("valid-product.zip")) {
        const adminListing = await api(admin, `/api/admin/listings/${listingId}`);
        const video = adminListing.data.files.find((file: any) => file.kind === "video");
        assert.ok(video, "source video should be recorded as stripped");
        assert.equal(video.stripped, 1);
        assert.equal(video.included, 0);
      }
      const published = await api(admin, `/api/admin/listings/${listingId}/publish`, { method: "POST" });
      assert.equal(published.response.status, 200, JSON.stringify(published.data));
      const versioned = await api(admin, `/api/admin/listings/${listingId}`);
      assert.ok(versioned.data.listing.active_version_id, "new imports should publish through a version");
      assert.ok(versioned.data.versions.some((version: any) => version.status === "active"));
    }
    assert.equal(new Set(listingIds).size, 3);

    const duplicate = await importFixture(fixtures[0]);
    assert.equal(duplicate.data.job.status, "succeeded", JSON.stringify(duplicate.data));
    assert.match(duplicate.data.job.message, /复用已有版本/);
    const invalid = await importFixture(invalidFixture);
    assert.equal(invalid.data.job.status, "failed");
    assert.equal(existsSync(uploadRoot) ? (await import("node:fs")).readdirSync(uploadRoot).length : 0, 0);
  });

  it("imports a v2 package into an isolated draft version and atomically publishes it", async () => {
    const imported = await importFixture(v2CoreFixture);
    assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
    assert.equal(imported.data.job.status, "succeeded", JSON.stringify(imported.data));
    const listingId = String(imported.data.job.listing_id);
    const adminListing = await api(admin, `/api/admin/listings/${listingId}`);
    assert.equal(adminListing.response.status, 200, JSON.stringify(adminListing.data));
    assert.equal(adminListing.data.versions.length, 1);
    assert.equal(adminListing.data.versions[0].status, "draft");
    assert.equal(adminListing.data.assets.length, 1);
    assert.equal(adminListing.data.assets[0].included, 1);

    const draftPreview = await fetch(
      `http://127.0.0.1:${port}/api/admin/listings/${listingId}/preview?version_id=${encodeURIComponent(adminListing.data.versions[0].id)}&file=resource.md`,
      { headers: { cookie: admin.cookie } }
    );
    assert.equal(draftPreview.status, 200);
    assert.match(draftPreview.headers.get("content-type") || "", /text\/markdown/);
    const draftRange = await fetch(
      `http://127.0.0.1:${port}/api/admin/listings/${listingId}/preview?version_id=${encodeURIComponent(adminListing.data.versions[0].id)}&file=resource.md`,
      { headers: { cookie: admin.cookie, range: "bytes=0-3" } }
    );
    assert.equal(draftRange.status, 206);
    assert.equal(draftRange.headers.get("content-range"), "bytes 0-3/19");
    const anonymousDraftPreview = await fetch(
      `http://127.0.0.1:${port}/api/admin/listings/${listingId}/preview?version_id=${encodeURIComponent(adminListing.data.versions[0].id)}&file=resource.md`
    );
    assert.equal(anonymousDraftPreview.status, 401);

    const published = await api(admin, `/api/admin/listings/${listingId}/publish`, { method: "POST" });
    assert.equal(published.response.status, 200, JSON.stringify(published.data));
    const publicListing = await api(anonymous, `/api/listings/${listingId}`);
    assert.equal(publicListing.response.status, 200, JSON.stringify(publicListing.data));
    assert.equal(publicListing.data.files[0].filename, "resource.md");
    const publicPreview = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingId}/preview?file=resource.md`
    );
    assert.equal(publicPreview.status, 200);
    assert.match(publicPreview.headers.get("content-type") || "", /text\/markdown/);

    const repeated = await importFixture(v2CoreFixture);
    assert.equal(repeated.data.job.status, "succeeded", JSON.stringify(repeated.data));
    const db = new DatabaseSync(dbPath);
    const versions = db.prepare(`SELECT COUNT(*) AS count FROM listing_versions WHERE listing_id = ?`).get(listingId) as { count: number };
    assert.equal(versions.count, 1);
    db.close();
  });

  it("serves only a derived public preview for imported AI audio", async () => {
    const imported = await importFixture(v2MediaFixture);
    assert.equal(imported.data.job.status, "succeeded", JSON.stringify(imported.data));
    const listingId = String(imported.data.job.listing_id);
    const draft = await api(admin, `/api/admin/listings/${listingId}`);
    const fullAudio = draft.data.assets.find((asset: any) => asset.kind === "audio_overview");
    const previewAudio = draft.data.assets.find((asset: any) => asset.kind === "preview_audio");
    assert.ok(fullAudio);
    assert.ok(previewAudio);
    assert.equal(fullAudio.included, 0);
    assert.equal(fullAudio.variant_group_id, "audio-overview");
    const selected = await api(admin, `/api/admin/listings/${listingId}`, {
      method: "PATCH",
      body: JSON.stringify({ version_id: draft.data.versions[0].id, included_asset_ids: [fullAudio.id, previewAudio.id] })
    });
    assert.equal(selected.response.status, 200, JSON.stringify(selected.data));
    const curated = await api(admin, `/api/admin/listings/${listingId}`);
    assert.equal(
      curated.data.assets.find((asset: any) => asset.id === previewAudio.id).included,
      0,
      "preview derivatives must not enter the download set"
    );
    assert.equal((await api(admin, `/api/admin/listings/${listingId}/publish`, { method: "POST" })).response.status, 200);
    const preview = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingId}/preview?file=${encodeURIComponent(previewAudio.filename)}`
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "audio/mp4");
    const fullPreview = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingId}/preview?file=${encodeURIComponent(fullAudio.filename)}`
    );
    assert.equal(fullPreview.status, 403);
    const adminFullPreview = await api(
      admin,
      `/api/downloads/${listingId}/preview?file=${encodeURIComponent(fullAudio.filename)}`,
      { headers: { range: "bytes=0-15" } }
    );
    assert.equal(adminFullPreview.response.status, 206, JSON.stringify(adminFullPreview.data));
    assert.equal(adminFullPreview.response.headers.get("cache-control"), "private, no-store");
    const checkout = await api(admin, `/api/me/listings/${listingId}/checkout`, { method: "POST" });
    assert.equal(checkout.response.status, 200, JSON.stringify(checkout.data));
    const fullDownloadToken = await api(
      admin,
      `/api/me/listings/${listingId}/download-token?file=${encodeURIComponent(fullAudio.filename)}`,
      { method: "POST" }
    );
    assert.equal(fullDownloadToken.response.status, 200, JSON.stringify(fullDownloadToken.data));
    assert.match(String(fullDownloadToken.data.url), new RegExp(encodeURIComponent(fullAudio.filename)));
    const fullDownload = await fetch(`http://127.0.0.1:${port}${fullDownloadToken.data.url}`);
    assert.equal(fullDownload.status, 200, await fullDownload.text());
    assert.equal(fullDownload.headers.get("content-type"), "audio/mp4");
    const previewDownloadToken = await api(
      admin,
      `/api/me/listings/${listingId}/download-token?file=${encodeURIComponent(previewAudio.filename)}`,
      { method: "POST" }
    );
    assert.equal(previewDownloadToken.response.status, 404);
    buildV2MediaUpdateFixture();
    const updated = await importFixture(v2MediaUpdateFixture);
    assert.equal(updated.data.job.status, "succeeded", JSON.stringify(updated.data));
    const refreshedDraft = await api(admin, `/api/admin/listings/${listingId}`);
    const refreshedVersion = refreshedDraft.data.versions.find((version: any) => version.status === "draft");
    const refreshedFullAudio = refreshedDraft.data.assets.find(
      (asset: any) => asset.version_id === refreshedVersion.id && asset.kind === "audio_overview"
    );
    assert.ok(refreshedFullAudio);
    assert.equal(refreshedFullAudio.included, 0, "v2 full media must be curated again after each import");
    const ownedFullPreview = await api(admin,
      `/api/downloads/${listingId}/preview?file=${encodeURIComponent(fullAudio.filename)}`,
      { headers: { range: "bytes=0-15" } }
    );
    assert.equal(ownedFullPreview.response.status, 206, JSON.stringify(ownedFullPreview.data));
    assert.equal(ownedFullPreview.response.headers.get("cache-control"), "private, no-store");
    assert.match(ownedFullPreview.response.headers.get("vary") || "", /Cookie/);

    // An active version can retain a full-media blob for a later review. Its
    // entitlement must not make it reachable until operations includes it.
    const db = new DatabaseSync(dbPath);
    db.prepare(`UPDATE listing_assets SET included = 0 WHERE id = ?`).run(fullAudio.id);
    db.close();
    const withheldFullMedia = await api(admin,
      `/api/downloads/${listingId}/preview?file=${encodeURIComponent(fullAudio.filename)}`
    );
    assert.equal(withheldFullMedia.response.status, 403, JSON.stringify(withheldFullMedia.data));
    const retainedPreview = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingId}/preview?file=${encodeURIComponent(previewAudio.filename)}`
    );
    assert.equal(retainedPreview.status, 200);
  });

  it("serves only a derived public preview for imported AI video", async () => {
    const imported = await importFixture(v2VideoFixture);
    assert.equal(imported.data.job.status, "succeeded", JSON.stringify(imported.data));
    const listingId = String(imported.data.job.listing_id);
    const draft = await api(admin, `/api/admin/listings/${listingId}`);
    const fullVideo = draft.data.assets.find((asset: any) => asset.kind === "video_overview");
    const previewVideo = draft.data.assets.find((asset: any) => asset.kind === "preview_video");
    const poster = draft.data.assets.find((asset: any) => asset.kind === "poster");
    assert.ok(fullVideo);
    assert.ok(previewVideo);
    assert.ok(poster);
    assert.equal(fullVideo.included, 0);
    await api(admin, `/api/admin/listings/${listingId}`, {
      method: "PATCH",
      body: JSON.stringify({ version_id: draft.data.versions[0].id, included_asset_ids: [fullVideo.id] })
    });
    assert.equal((await api(admin, `/api/admin/listings/${listingId}/publish`, { method: "POST" })).response.status, 200);
    const publicListing = await api(anonymous, `/api/listings/${listingId}`);
    assert.equal(publicListing.data.files.find((file: any) => file.kind === "video_overview").is_previewable, 0);
    assert.equal(publicListing.data.files.find((file: any) => file.kind === "preview_video").is_previewable, 1);
    assert.equal(publicListing.data.files.find((file: any) => file.kind === "poster").is_previewable, 1);
    const fullPreview = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingId}/preview?file=${encodeURIComponent(fullVideo.filename)}`
    );
    assert.equal(fullPreview.status, 403);
    const preview = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingId}/preview?file=${encodeURIComponent(previewVideo.filename)}`
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "video/mp4");
    const posterResponse = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingId}/preview?file=${encodeURIComponent(poster.filename)}`
    );
    assert.equal(posterResponse.status, 200);
    assert.equal(posterResponse.headers.get("content-type"), "image/png");
    assert.equal((await api(admin, `/api/me/listings/${listingId}/checkout`, { method: "POST" })).response.status, 200);
    const ownedFullVideo = await api(admin,
      `/api/downloads/${listingId}/preview?file=${encodeURIComponent(fullVideo.filename)}`,
      { headers: { range: "bytes=0-15" } }
    );
    assert.equal(ownedFullVideo.response.status, 206, JSON.stringify(ownedFullVideo.data));
    assert.equal(ownedFullVideo.response.headers.get("cache-control"), "private, no-store");
  });

  it("rejects a v2 package whose public preview is not parseable media", async () => {
    const imported = await importFixture(invalidV2PreviewMediaFixture);
    assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
    assert.equal(imported.data.job.status, "failed", JSON.stringify(imported.data));
    assert.match(String(imported.data.job.message), /MEDIA_PROBE_FAILED|MEDIA_METADATA_INVALID/);
  });

  it("rejects an oversized derived preview with its stable error code", async () => {
    const imported = await importFixture(v2PreviewLimitFixture);
    assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
    assert.equal(imported.data.job.status, "failed", JSON.stringify(imported.data));
    assert.match(String(imported.data.job.message), /PREVIEW_FILE_TOO_LARGE/);
  });

  it("rejects complete media over the configured per-kind limit", async () => {
    const imported = await importFixture(v2FullMediaLimitFixture);
    assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
    assert.equal(imported.data.job.status, "failed", JSON.stringify(imported.data));
    assert.match(String(imported.data.job.message), /MEDIA_FILE_TOO_LARGE/);
  });

  it("rejects media whose declared metadata differs from ffprobe", async () => {
    const imported = await importFixture(v2MediaMismatchFixture);
    assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
    assert.equal(imported.data.job.status, "failed", JSON.stringify(imported.data));
    assert.match(String(imported.data.job.message), /MEDIA_METADATA_MISMATCH/);
  });

  it("rejects v2 packages that carry credentials, sensitive names, or default-included subtitles", async () => {
    for (const fixture of invalidV2SafetyFixtures) {
      const imported = await importFixture(fixture);
      assert.equal(imported.response.status, 200, JSON.stringify(imported.data));
      assert.equal(imported.data.job.status, "failed", `${fixture}: ${JSON.stringify(imported.data)}`);
    }
  });

  it("updates admin-only LLM settings without echoing the API key", async () => {
    const before = await api(admin, "/api/admin/llm/settings");
    assert.equal(before.response.status, 200, JSON.stringify(before.data));
    assert.equal(before.data.settings.api_key, "");
    assert.equal(before.data.settings.api_key_configured, false);

    const updated = await api(admin, "/api/admin/llm/settings", {
      method: "PUT",
      body: JSON.stringify({
        enabled: false,
        provider: "aimodelhub",
        api_base: "https://llm.example.test/v1/",
        api_key: "smoke#summary key",
        model: "summary-primary",
        fallback_models: ["summary-fallback", "summary-primary", "summary-fallback"],
        timeout_ms: 30000,
        temperature: 0.3,
        max_tokens: 320
      })
    });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.settings.api_key, "");
    assert.equal(updated.data.settings.api_key_configured, true);
    assert.equal(updated.data.settings.api_base, "https://llm.example.test/v1");
    assert.deepEqual(updated.data.settings.fallback_models, ["summary-fallback"]);
    assert.equal(updated.data.backfill_scheduled, false);
    const persisted = readFileSync(configEnvPath, "utf8");
    assert.match(persisted, /SUMMARY_LLM_API_KEY="smoke#summary key"/);
    assert.doesNotMatch(JSON.stringify(updated.data), /smoke#summary key/);

    const retained = await api(admin, "/api/admin/llm/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...updated.data.settings,
        api_key: "",
        model: "summary-primary-v2"
      })
    });
    assert.equal(retained.response.status, 200, JSON.stringify(retained.data));
    assert.equal(retained.data.settings.api_key_configured, true);
    assert.match(readFileSync(configEnvPath, "utf8"), /SUMMARY_LLM_API_KEY="smoke#summary key"/);

    const injection = await api(admin, "/api/admin/llm/settings", {
      method: "PUT",
      body: JSON.stringify({
        ...updated.data.settings,
        model: "summary-primary\nSESSION_SECRET=overwritten"
      })
    });
    assert.equal(injection.response.status, 400);
    assert.doesNotMatch(readFileSync(configEnvPath, "utf8"), /SESSION_SECRET=overwritten/);
  });

  it("discovers models with pending connection settings without persisting the API key", async () => {
    const discovered = await api(admin, "/api/admin/llm/models", {
      method: "POST",
      body: JSON.stringify({
        api_base: `http://127.0.0.1:${modelPort}/v1`,
        api_key: "pending-model-key",
        timeout_ms: 5000
      })
    });
    assert.equal(discovered.response.status, 200, JSON.stringify(discovered.data));
    assert.deepEqual(discovered.data.models.map((model: any) => model.id), [
      "summary-primary",
      "summary-backup"
    ]);
    assert.doesNotMatch(readFileSync(configEnvPath, "utf8"), /pending-model-key/);
  });

  it("backfills legacy title-only summaries without changing publication", async () => {
    const listingId = listingIds[1];
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `UPDATE listings SET
         summary = title, summary_origin = 'fallback', summary_source_hash = NULL,
         summary_model = NULL, summary_generated_at = NULL, summary_locked = 0
       WHERE id = ?`
    ).run(listingId);
    db.close();

    const result = await api(admin, "/api/admin/listings/backfill-summaries", {
      method: "POST",
      body: JSON.stringify({ limit: 10 })
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.ok(result.data.updated >= 1);

    const updated = await api(admin, `/api/admin/listings/${listingId}`);
    assert.equal(updated.data.listing.status, "published");
    assert.notEqual(updated.data.listing.summary, updated.data.listing.title);
    assert.equal(updated.data.listing.summary_status, "ready");
    assert.equal(updated.data.listing.summary_origin, "fallback");
    assert.match(updated.data.listing.summary_source_hash, /^[a-f0-9]{64}$/);
  });

  it("publishes all eligible drafts and reports skipped entries", async () => {
    const db = new DatabaseSync(dbPath);
    const adminUser = db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .get(seedAdminEmail) as { id: string };
    const now = new Date().toISOString();
    const publishableId = listingIds[0];
    const skippedId = "lst_smoke_empty_draft";

    db.prepare(
      `UPDATE listings SET status = 'draft', published_at = NULL, updated_at = ? WHERE id = ?`
    ).run(now, publishableId);
    db.prepare(
      `INSERT INTO listings (
        id, title, summary, author_user_id, source_task_id, price_tier, price_credits,
        status, created_at, updated_at
      ) VALUES (?, ?, '', ?, ?, 'standard', 12, 'draft', ?, ?)`
    ).run(skippedId, "无文件草稿", adminUser.id, "task_smoke_empty_draft", now, now);
    db.close();

    const listed = await api(admin, "/api/admin/listings");
    assert.ok(listed.data.draft_count >= 2);

    const result = await api(admin, "/api/admin/listings/publish-all", { method: "POST" });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.published_count, 1);
    assert.equal(result.data.skipped_count, 2);
    assert.ok(result.data.skipped.some((entry: any) => entry.id === skippedId));

    const verify = new DatabaseSync(dbPath);
    const published = verify
      .prepare(`SELECT status, published_at FROM listings WHERE id = ?`)
      .get(publishableId) as { status: string; published_at: string | null };
    const skipped = verify
      .prepare(`SELECT status FROM listings WHERE id = ?`)
      .get(skippedId) as { status: string };
    assert.equal(published.status, "published");
    assert.ok(published.published_at);
    assert.equal(skipped.status, "draft");
    assert.equal(
      (verify
        .prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'listing.publish_all'`)
        .get() as { count: number }).count,
      1
    );
    verify.prepare(`DELETE FROM listings WHERE id = ?`).run(skippedId);
    verify.close();

    const repeated = await api(admin, "/api/admin/listings/publish-all", { method: "POST" });
    assert.equal(repeated.response.status, 200, JSON.stringify(repeated.data));
    assert.equal(repeated.data.published_count, 0);
    assert.equal(repeated.data.skipped_count, 1);
  });

  it("supports search, topic filters and pagination", async () => {
    const search = await api(anonymous, "/api/listings?q=夹具&limit=2&page=1");
    assert.equal(search.response.status, 200);
    assert.equal(search.data.listings.length, 2);
    assert.equal(search.data.pagination.total, 3);
    assert.equal(search.data.pagination.pages, 2);
    const second = await api(anonymous, "/api/listings?q=夹具&limit=2&page=2");
    assert.equal(second.data.listings.length, 1);
    const topic = await api(anonymous, "/api/listings?topic=ai-eng");
    assert.ok(topic.data.listings.some((listing: any) => listingIds.includes(listing.id)));
    const mixedPublic = await api(anonymous, `/api/listings/${listingIds[2]}`);
    const publicVideo = mixedPublic.data.files.find((file: any) => file.kind === "video");
    assert.equal(publicVideo, undefined, "source video must not be exposed publicly");
    const videoPreview = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingIds[2]}/preview?file=source.mp4`
    );
    assert.equal(videoPreview.status, 403);
    const fallbackCover = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingIds[1]}/cover`
    );
    assert.equal(fallbackCover.status, 200);
    assert.equal(fallbackCover.headers.get("content-type"), "image/png");
    assert.ok((await fallbackCover.arrayBuffer()).byteLength > 100);
  });

  it("keeps likes idempotent and exposes day/week/all ranks", async () => {
    const liked = await api(user, `/api/me/likes/${listingIds[0]}`, { method: "POST" });
    assert.equal(liked.data.liked, true);
    for (const period of ["day", "week", "all"]) {
      const rank = await api(anonymous, `/api/rank?metric=likes&period=${period}`);
      const row = rank.data.items.find((item: any) => item.id === listingIds[0]);
      assert.equal(row.rank_count, 1);
      assert.deepEqual([...row.tags].sort(), ["保留标签", "策展标签"]);
    }
    const unliked = await api(user, `/api/me/likes/${listingIds[0]}`, { method: "POST" });
    assert.equal(unliked.data.liked, false);
    const detail = await api(anonymous, `/api/listings/${listingIds[0]}`);
    assert.equal(detail.data.listing.like_count, 0);
  });

  it("reconciles ledger, preserves share snapshots and prevents double charging", async () => {
    const beforeMe = await api(user, "/api/auth/me");
    const beforeBalance = beforeMe.data.account.balance;
    const first = await api(user, `/api/me/listings/${listingIds[0]}/checkout`, { method: "POST" });
    assert.equal(first.response.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.price, 12);
    const again = await api(user, `/api/me/listings/${listingIds[0]}/checkout`, { method: "POST" });
    assert.equal(again.data.alreadyOwned, true);
    const afterRepeat = await api(user, "/api/auth/me");
    assert.equal(afterRepeat.data.account.balance, beforeBalance - 12);

    const share = await api(admin, "/api/admin/revenue-share", {
      method: "POST",
      body: JSON.stringify({ author_share_bps: 6000, platform_share_bps: 4000 })
    });
    assert.equal(share.response.status, 200, JSON.stringify(share.data));
    const second = await api(user, `/api/me/listings/${listingIds[1]}/checkout`, { method: "POST" });
    assert.equal(second.response.status, 200, JSON.stringify(second.data));

    const orders = await api(admin, "/api/admin/orders");
    const firstOrder = orders.data.orders.find((order: any) => order.listing_id === listingIds[0]);
    const secondOrder = orders.data.orders.find((order: any) => order.listing_id === listingIds[1]);
    assert.equal(firstOrder.author_share_bps, 7000);
    assert.equal(secondOrder.author_share_bps, 6000);

    const author = await api(admin, "/api/auth/me");
    assert.equal(author.data.account.pending_earnings, 15);
    const ledger = await api(user, "/api/me/ledger");
    assert.equal(
      ledger.data.entries.reduce((sum: number, entry: any) => sum + entry.amount, 0),
      (await api(user, "/api/auth/me")).data.account.balance
    );
  });

  it("handles free downloads and concurrent checkout without duplicate orders", async () => {
    const freePatch = await api(admin, `/api/admin/listings/${listingIds[2]}`, {
      method: "PATCH",
      body: JSON.stringify({ price_tier: "free" })
    });
    assert.equal(freePatch.response.status, 200, JSON.stringify(freePatch.data));
    const balance = (await api(user, "/api/auth/me")).data.account.balance;
    const free = await api(user, `/api/me/listings/${listingIds[2]}/checkout`, { method: "POST" });
    assert.equal(free.data.free, true);
    assert.equal((await api(user, "/api/auth/me")).data.account.balance, balance);
    const freeToken = await api(user, `/api/me/listings/${listingIds[2]}/download-token`, { method: "POST" });
    assert.equal((await fetch(`http://127.0.0.1:${port}${freeToken.data.url}`)).status, 200);

    const registered = await api(secondUser, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: "second@example.com", password: "password123", display_name: "第二位用户" })
    });
    assert.equal(registered.response.status, 200, JSON.stringify(registered.data));
    await api(admin, "/api/admin/credits/grant", {
      method: "POST",
      body: JSON.stringify({ email: "second@example.com", amount: 50, note: "并发验收" })
    });
    assert.equal(
      (await api(secondUser, `/api/me/likes/${listingIds[0]}`, { method: "POST" })).data.liked,
      true
    );
    const results = await Promise.all([
      api(secondUser, `/api/me/listings/${listingIds[0]}/checkout`, { method: "POST" }),
      api(secondUser, `/api/me/listings/${listingIds[0]}/checkout`, { method: "POST" })
    ]);
    assert.ok(results.every((result) => result.response.status === 200));
    assert.equal(results.filter((result) => result.data.alreadyOwned === true).length, 1);
    assert.equal((await api(secondUser, "/api/auth/me")).data.account.balance, 38);
    const secondToken = await api(secondUser, `/api/me/listings/${listingIds[0]}/download-token`, { method: "POST" });
    assert.equal((await fetch(`http://127.0.0.1:${port}${secondToken.data.url}`)).status, 200);

    for (const period of ["day", "week", "all"]) {
      const downloadRank = await api(anonymous, `/api/rank?metric=downloads&period=${period}`);
      assert.ok(downloadRank.data.items.some((item: any) => Number(item.rank_count) >= 1));
    }
  });

  it("supports unpaid preview and paid single-file download", async () => {
    const detail = await api(anonymous, `/api/listings/${listingIds[0]}`);
    assert.equal(detail.response.status, 200);
    const previewable = detail.data.files.find(
      (file: any) =>
        file.is_previewable === 1 ||
        file.kind === "content" ||
        file.kind === "slide_pdf" ||
        file.kind === "infographic"
    );
    assert.ok(previewable, "expected a previewable file");
    const preview = await fetch(
      `http://127.0.0.1:${port}/api/downloads/${listingIds[0]}/preview?file=${encodeURIComponent(previewable.filename)}`
    );
    assert.equal(preview.status, 200, await preview.text());
    assert.match(preview.headers.get("content-disposition") || "", /inline/i);

    const visitor: Client = { cookie: "" };
    const registered = await api(visitor, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: "preview-visitor@example.com",
        password: "password12345",
        display_name: "预览访客"
      })
    });
    assert.equal(registered.response.status, 200, JSON.stringify(registered.data));

    const unpaid = await api(
      visitor,
      `/api/me/listings/${listingIds[0]}/download-token?file=${encodeURIComponent(previewable.filename)}`,
      { method: "POST" }
    );
    assert.equal(unpaid.response.status, 403);

    await api(admin, "/api/admin/credits/grant", {
      method: "POST",
      body: JSON.stringify({ email: "preview-visitor@example.com", amount: 20, note: "preview paywall" })
    });
    const paidCheckout = await api(visitor, `/api/me/listings/${listingIds[0]}/checkout`, { method: "POST" });
    assert.equal(paidCheckout.response.status, 200, JSON.stringify(paidCheckout.data));
    const tokenRes = await api(
      visitor,
      `/api/me/listings/${listingIds[0]}/download-token?file=${encodeURIComponent(previewable.filename)}`,
      { method: "POST" }
    );
    assert.equal(tokenRes.response.status, 200, JSON.stringify(tokenRes.data));
    assert.match(String(tokenRes.data.url), /file=/);
    const paid = await fetch(`http://127.0.0.1:${port}${tokenRes.data.url}`);
    assert.equal(paid.status, 200, await paid.text());
    assert.match(paid.headers.get("content-disposition") || "", /attachment/i);
  });

  it("serves signed downloads, expires tokens and preserves purchased access after takedown", async () => {
    const token = await api(user, `/api/me/listings/${listingIds[0]}/download-token`, { method: "POST" });
    assert.equal(token.response.status, 200);
    const download = await fetch(`http://127.0.0.1:${port}${token.data.url}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
    const bad = await fetch(`http://127.0.0.1:${port}/api/downloads/${listingIds[0]}?token=nope`);
    assert.equal(bad.status, 403);
    assert.equal(verifyDownloadToken(makeDownloadToken("listing", "user", -1)), null);

    const takenDown = await api(admin, `/api/admin/listings/${listingIds[0]}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "taken_down" })
    });
    assert.equal(takenDown.response.status, 200, JSON.stringify(takenDown.data));
    assert.equal((await api(anonymous, `/api/listings/${listingIds[0]}`)).response.status, 404);
    const ownedToken = await api(user, `/api/me/listings/${listingIds[0]}/download-token`, { method: "POST" });
    assert.equal(ownedToken.response.status, 200, JSON.stringify(ownedToken.data));
    assert.equal((await fetch(`http://127.0.0.1:${port}${ownedToken.data.url}`)).status, 200);
    assert.equal(
      (await api(admin, `/api/admin/listings/${listingIds[0]}/publish`, { method: "POST" })).response.status,
      409
    );
  });

  it("renders OG share metadata without exposing a download", async () => {
    const shared = await api(user, `/api/me/listings/${listingIds[1]}/share`, { method: "POST" });
    assert.equal(shared.response.status, 200, JSON.stringify(shared.data));
    firstShareSlug = shared.data.slug;
    assert.equal(shared.data.public_path, `/s/${firstShareSlug}`);
    const page = await fetch(`http://127.0.0.1:${port}/s/${firstShareSlug}`);
    const body = await page.text();
    assert.equal(page.status, 200);
    assert.match(body, /property="og:title"/);
    assert.match(body, /property="og:image"/);
    const publicShare = await api(anonymous, `/api/share/${firstShareSlug}`);
    assert.equal(publicShare.response.status, 200);
    assert.equal("storage_path" in publicShare.data.share, false);
  });

  it("supports profile, reports, governance and auditable admin changes", async () => {
    const profile = await api(user, "/api/me/profile", {
      method: "PATCH",
      body: JSON.stringify({ display_name: "青木更新" })
    });
    assert.equal(profile.data.user.display_name, "青木更新");
    const report = await api(user, `/api/me/listings/${listingIds[1]}/report`, {
      method: "POST",
      body: JSON.stringify({ reason: "copyright", detail: "授权范围待复核" })
    });
    assert.equal(report.response.status, 200, JSON.stringify(report.data));
    const reports = await api(admin, "/api/admin/reports?status=open");
    assert.ok(reports.data.reports.some((item: any) => item.id === report.data.id));
    const resolved = await api(admin, `/api/admin/reports/${report.data.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved", resolution: "已复核并下架", take_down: true })
    });
    assert.equal(resolved.response.status, 200, JSON.stringify(resolved.data));
    assert.equal((await api(anonymous, `/api/listings/${listingIds[1]}`)).response.status, 404);

    const users = await api(admin, "/api/admin/users");
    assert.ok(users.data.users.some((item: any) => item.email === "second@example.com"));
    const audits = await api(admin, "/api/admin/audit-logs");
    for (const action of ["import.succeeded", "listing.publish", "credits.grant", "revenue_share.create", "report.resolve"]) {
      assert.ok(audits.data.logs.some((item: any) => item.action === action), action);
    }
  });

  it("enforces download token rate limiting", async () => {
    const responses = [];
    for (let index = 0; index < 35; index++) {
      responses.push(
        await api(secondUser, `/api/me/listings/${listingIds[0]}/download-token`, { method: "POST" })
      );
    }
    assert.ok(responses.some((result) => result.response.status === 429));
  });

  it("keeps database-level ledger and entitlement invariants", () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const mismatches = db
      .prepare(
        `SELECT a.user_id, a.balance, COALESCE(SUM(l.amount), 0) AS ledger_sum
         FROM credit_accounts a LEFT JOIN ledger_entries l ON l.user_id = a.user_id
         GROUP BY a.user_id HAVING a.balance != COALESCE(SUM(l.amount), 0)`
      )
      .all();
    assert.deepEqual(mismatches, []);
    const duplicates = db
      .prepare(
        `SELECT buyer_user_id, listing_id, COUNT(*) AS count FROM orders
         GROUP BY buyer_user_id, listing_id HAVING COUNT(*) > 1`
      )
      .all();
    assert.deepEqual(duplicates, []);
    db.close();
  });
});

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const production = process.env.NODE_ENV === "production";

function enabled(name: string, fallback = true): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
}

function csv(name: string): string[] {
  return [...new Set((process.env[name] ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function secret(name: string, minLength = 32): string {
  const value = env(name);
  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters`);
  }
  return value;
}

const seedUsers = process.env.SEED_USERS === "true";
const seedTestUser = seedUsers && process.env.SEED_TEST_USER === "true";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  databasePath: resolve(root, process.env.DATABASE_PATH ?? "./data/gallery.db"),
  blobRoot: resolve(root, process.env.BLOB_ROOT ?? "./data/blobs"),
  blobStorageBackend: process.env.BLOB_STORAGE_BACKEND?.trim().toLowerCase() === "s3" ? "s3" as const : "filesystem" as const,
  blobS3Bucket: process.env.BLOB_S3_BUCKET?.trim() ?? "",
  blobS3Region: process.env.BLOB_S3_REGION?.trim() || "us-east-1",
  blobS3Endpoint: process.env.BLOB_S3_ENDPOINT?.trim() ?? "",
  blobS3Prefix: process.env.BLOB_S3_PREFIX?.trim().replace(/^\/+|\/+$/g, "") ?? "resource-gallery",
  blobS3ForcePathStyle: enabled("BLOB_S3_FORCE_PATH_STYLE", false),
  uploadRoot: resolve(root, process.env.UPLOAD_ROOT ?? "./data/uploads"),
  production,
  secureCookies: production,
  seedUsers,
  seedTestUser,
  sessionSecret: secret("SESSION_SECRET"),
  downloadSigningSecret: secret("DOWNLOAD_SIGNING_SECRET"),
  maxPackageBytes: Number(process.env.MAX_PACKAGE_BYTES ?? 512 * 1024 * 1024),
  maxUncompressedPackageBytes: Number(process.env.MAX_UNCOMPRESSED_PACKAGE_BYTES ?? 768 * 1024 * 1024),
  maxAudioOverviewBytes: Number(process.env.MAX_AUDIO_OVERVIEW_BYTES ?? 64 * 1024 * 1024),
  maxVideoOverviewBytes: Number(process.env.MAX_VIDEO_OVERVIEW_BYTES ?? 128 * 1024 * 1024),
  maxPreviewBytes: Number(process.env.MAX_PREVIEW_BYTES ?? 10 * 1024 * 1024),
  resourceGallerySyncEnabled: enabled("RESOURCE_GALLERY_SYNC_ENABLED", false),
  resourceGallerySyncToken: process.env.RESOURCE_GALLERY_SYNC_TOKEN?.trim() ?? "",
  resourceGallerySyncActorEmail: process.env.RESOURCE_GALLERY_SYNC_ACTOR_EMAIL?.trim() ?? "",
  resourceGallerySyncMaxRemovedFiles: Number(process.env.RESOURCE_GALLERY_SYNC_MAX_REMOVED_FILES ?? 0),
  resourceGallerySyncMaxAttempts: Number(process.env.RESOURCE_GALLERY_SYNC_MAX_ATTEMPTS ?? 3),
  envFilePath: resolve(root, process.env.CONFIG_ENV_PATH ?? "../../.env"),
  summaryLlmEnabled: enabled("SUMMARY_LLM_ENABLED"),
  summaryLlmProvider: process.env.SUMMARY_LLM_PROVIDER?.trim() || "openai-compatible",
  summaryLlmBaseUrl: process.env.SUMMARY_LLM_BASE_URL?.trim() ?? "",
  summaryLlmApiKey: process.env.SUMMARY_LLM_API_KEY?.trim() ?? "",
  summaryLlmModel: process.env.SUMMARY_LLM_MODEL?.trim() ?? "",
  summaryLlmFallbackModels: csv("SUMMARY_LLM_FALLBACK_MODELS"),
  summaryLlmTimeoutMs: Number(process.env.SUMMARY_LLM_TIMEOUT_MS ?? 20_000),
  summaryLlmTemperature: Number(process.env.SUMMARY_LLM_TEMPERATURE ?? 0.2),
  summaryLlmMaxTokens: Number(process.env.SUMMARY_LLM_MAX_TOKENS ?? 240),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://127.0.0.1:5173",
  webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
  seedAdminEmail: seedUsers ? env("SEED_ADMIN_EMAIL") : "",
  seedAdminPassword: seedUsers ? secret("SEED_ADMIN_PASSWORD", 12) : "",
  seedUserEmail: seedTestUser ? env("SEED_USER_EMAIL") : "",
  seedUserPassword: seedTestUser ? secret("SEED_USER_PASSWORD", 12) : ""
};

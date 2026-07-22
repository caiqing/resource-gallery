import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const production = process.env.NODE_ENV === "production";

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
  uploadRoot: resolve(root, process.env.UPLOAD_ROOT ?? "./data/uploads"),
  production,
  secureCookies: production,
  seedUsers,
  seedTestUser,
  sessionSecret: secret("SESSION_SECRET"),
  downloadSigningSecret: secret("DOWNLOAD_SIGNING_SECRET"),
  maxPackageBytes: Number(process.env.MAX_PACKAGE_BYTES ?? 100 * 1024 * 1024),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://127.0.0.1:5173",
  webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
  seedAdminEmail: seedUsers ? env("SEED_ADMIN_EMAIL") : "",
  seedAdminPassword: seedUsers ? secret("SEED_ADMIN_PASSWORD", 12) : "",
  seedUserEmail: seedTestUser ? env("SEED_USER_EMAIL") : "",
  seedUserPassword: seedTestUser ? secret("SEED_USER_PASSWORD", 12) : ""
};

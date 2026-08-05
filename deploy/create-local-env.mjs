#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const deployDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const envPath = resolve(deployDir, ".env");

if (existsSync(envPath)) {
  console.error("deploy/.env already exists; refusing to replace local credentials.");
  process.exit(1);
}

const values = {
  NODE_ENV: "development",
  PUBLIC_ORIGIN: "http://127.0.0.1",
  SITE_ADDRESS: ":80",
  SESSION_SECRET: randomBytes(32).toString("hex"),
  DOWNLOAD_SIGNING_SECRET: randomBytes(32).toString("hex"),
  BLOB_STORAGE_BACKEND: "filesystem",
  INITIAL_ADMIN_EMAIL: "admin@resource-gallery.local",
  INITIAL_ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
  RESOURCE_GALLERY_SYNC_ENABLED: "false"
};

const content = [
  "# Generated for local Docker use. Never commit this file.",
  ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
  ""
].join("\n");

writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
chmodSync(envPath, 0o600);
console.log("Created deploy/.env for local Docker use (administrator: admin@resource-gallery.local).");

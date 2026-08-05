import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDotEnv, validateConfig } from "./preflight.mjs";

const base = {
  NODE_ENV: "production",
  PUBLIC_ORIGIN: "https://gallery.example.com",
  SITE_ADDRESS: "gallery.example.com",
  SESSION_SECRET: "a".repeat(64),
  DOWNLOAD_SIGNING_SECRET: "b".repeat(64),
  INITIAL_ADMIN_EMAIL: "admin@example.com",
  INITIAL_ADMIN_PASSWORD: "a-strong-admin-password",
  BLOB_STORAGE_BACKEND: "s3",
  BLOB_S3_BUCKET: "resource-gallery-production",
  BLOB_S3_REGION: "us-east-1",
  BLOB_S3_PREFIX: "resource-gallery",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  RESOURCE_GALLERY_SYNC_ENABLED: "false"
};

describe("deployment preflight", () => {
  it("parses quoted dotenv values without printing or evaluating them", () => {
    assert.deepEqual(parseDotEnv('KEY="value#with-hash"\nOTHER=plain\n# ignored\n'), {
      KEY: "value#with-hash",
      OTHER: "plain"
    });
  });

  it("accepts a production base configuration with workload identity", () => {
    assert.deepEqual(validateConfig(base, "production"), []);
  });

  it("requires HTTPS, S3 and independent secrets in production", () => {
    const errors = validateConfig({
      ...base,
      PUBLIC_ORIGIN: "http://gallery.example.com",
      BLOB_STORAGE_BACKEND: "filesystem",
      SESSION_SECRET: base.DOWNLOAD_SIGNING_SECRET
    }, "production");
    assert.match(errors.join("\n"), /HTTPS/);
    assert.match(errors.join("\n"), /BLOB_STORAGE_BACKEND/);
    assert.match(errors.join("\n"), /必须不同/);
  });

  it("requires an explicit review sync configuration for production-review", () => {
    const errors = validateConfig({ ...base, RESOURCE_GALLERY_SYNC_ENABLED: "true" }, "production-review");
    assert.match(errors.join("\n"), /RESOURCE_GALLERY_SYNC_TOKEN/);
    assert.match(errors.join("\n"), /RESOURCE_GALLERY_SYNC_ACTOR_EMAIL/);
  });

  it("accepts the local filesystem profile without weakening production checks", () => {
    const errors = validateConfig({
      ...base,
      NODE_ENV: "development",
      PUBLIC_ORIGIN: "http://127.0.0.1",
      SITE_ADDRESS: ":80",
      BLOB_STORAGE_BACKEND: "filesystem"
    }, "local");
    assert.deepEqual(errors, []);
  });
});

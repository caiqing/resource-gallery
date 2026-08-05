import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readV1PackageMetadata, validateExportPackage, assertSafePackagePath, isDangerousKind } from "./validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

function ensureFixtures() {
  const needed = [
    "valid-basic.zip",
    "valid-design.zip",
    "valid-product.zip",
    "valid-video-only.zip",
    "valid-v2-media.zip",
    "valid-v2-variant-media.zip",
    "valid-v2-core.zip",
    "valid-v2-gated-core.zip",
    "invalid-v2-zero-media.zip",
    "invalid-v1-overview.zip",
    "invalid-v2-parent.zip",
    "invalid-v2-ambiguous-media.zip",
    "invalid-v2-duplicate-id.zip",
    "invalid-v2-duplicate-path.zip",
    "invalid-v2-filename-collision.zip",
    "invalid-v2-preview-distribution.zip",
    "invalid-v2-auth.zip",
    "invalid-v2-sensitive-name.zip",
    "invalid-v2-subtitle-default.zip",
    "invalid-v2-source-url.zip",
    "invalid-v2-local-path.zip",
    "invalid-v2-password.zip",
    "invalid-v2-undeclared-entry.zip",
    "invalid-schema.zip",
    "invalid-zipslip.zip"
  ];
  if (needed.every((n) => existsSync(join(fixtures, n)))) return;
  const r = spawnSync(process.execPath, [join(here, "build-fixtures.js")], {
    stdio: "inherit"
  });
  assert.equal(r.status, 0, "build fixtures failed");
}

describe("path safety", () => {
  it("rejects parent traversal", () => {
    assert.ok(assertSafePackagePath("../evil.txt"));
    assert.ok(assertSafePackagePath("files/../../evil.txt"));
    assert.ok(assertSafePackagePath("files//evil.txt"));
    assert.ok(assertSafePackagePath("files/evil.txt/"));
  });
  it("accepts normal files path", () => {
    assert.equal(assertSafePackagePath("files/deck.pdf"), null);
  });
});

describe("asset safety policy", () => {
  it("strips source media, subtitles, and credentials", () => {
    assert.equal(isDangerousKind("video", "source.mp4"), true);
    assert.equal(isDangerousKind("subtitle", "source.srt"), true);
    assert.equal(isDangerousKind("auth", "profile.json"), true);
    assert.equal(isDangerousKind("content", "api-token.md"), true);
  });
});

describe("validateExportPackage", () => {
  ensureFixtures();

  it("accepts three independent valid fixtures", async () => {
    for (const name of ["valid-basic.zip", "valid-design.zip", "valid-product.zip"]) {
      const res = await validateExportPackage(join(fixtures, name));
      assert.equal(res.ok, true, `${name}: ${JSON.stringify(res.issues, null, 2)}`);
      assert.ok(res.keptFiles.length >= 1);
      if (name === "valid-product.zip") {
        assert.ok(res.strippedFiles.some((file) => file.kind === "video"));
      }
    }
  });

  it("rejects a video-only package after source media stripping", async () => {
    const res = await validateExportPackage(join(fixtures, "valid-video-only.zip"));
    assert.equal(res.ok, false, JSON.stringify(res.issues));
    assert.equal(res.keptFiles.length, 0);
    assert.ok(res.issues.some((issue) => issue.code === "NO_USABLE_FILES"));
  });

  it("rejects overview kinds in a v1 package", async () => {
    const res = await validateExportPackage(join(fixtures, "invalid-v1-overview.zip"));
    assert.equal(res.ok, false, JSON.stringify(res.issues));
    assert.ok(res.issues.some((issue) => issue.code === "SCHEMA"));
  });

  it("accepts a v2 package with an overview and derived preview", async () => {
    const res = await validateExportPackage(join(fixtures, "valid-v2-media.zip"));
    assert.equal(res.ok, true, JSON.stringify(res.issues));
    assert.equal(res.manifest?.schema_version, "resource-gallery.export/v2");
    assert.equal(res.keptFiles.length, 2);
    assert.equal(res.keptFiles.find((file) => file.kind === "audio_overview")?.default_include, false);
  });

  it("accepts explicitly separated v2 media variant groups", async () => {
    const res = await validateExportPackage(join(fixtures, "valid-v2-variant-media.zip"));
    assert.equal(res.ok, true, JSON.stringify(res.issues));
    const groups = (res.manifest as any).assets
      .filter((asset: any) => asset.kind === "audio_overview")
      .map((asset: any) => asset.variant_group_id)
      .sort();
    assert.deepEqual(groups, ["audio-en", "audio-zh"]);
  });

  it("preserves an explicit v2 default_include=false for core assets", async () => {
    const res = await validateExportPackage(join(fixtures, "valid-v2-gated-core.zip"));
    assert.equal(res.ok, true, JSON.stringify(res.issues));
    assert.equal(res.keptFiles.find((file) => file.kind === "content")?.default_include, false);
  });

  it("rejects v2 derived media with a missing parent", async () => {
    const res = await validateExportPackage(join(fixtures, "invalid-v2-parent.zip"));
    assert.equal(res.ok, false, JSON.stringify(res.issues));
    assert.ok(res.issues.some((issue) => issue.code === "ASSET_PARENT_INVALID"));
  });

  it("rejects multiple full media assets in one variant group", async () => {
    const res = await validateExportPackage(join(fixtures, "invalid-v2-ambiguous-media.zip"));
    assert.equal(res.ok, false, JSON.stringify(res.issues));
    assert.ok(res.issues.some((issue) => issue.code === "MEDIA_VARIANT_AMBIGUOUS"));
  });

  it("rejects zero-byte v2 media before import", async () => {
    const res = await validateExportPackage(join(fixtures, "invalid-v2-zero-media.zip"));
    assert.equal(res.ok, false, JSON.stringify(res.issues));
    assert.ok(res.issues.some((issue) => issue.code === "MEDIA_EMPTY"));
  });

  it("rejects duplicate v2 asset ids, paths, and filenames", async () => {
    const cases = [
      ["invalid-v2-duplicate-id.zip", "ASSET_ID_DUPLICATE"],
      ["invalid-v2-duplicate-path.zip", "ASSET_PATH_DUPLICATE"],
      ["invalid-v2-filename-collision.zip", "ASSET_FILENAME_COLLISION"]
    ] as const;
    for (const [name, code] of cases) {
      const res = await validateExportPackage(join(fixtures, name));
      assert.equal(res.ok, false, `${name}: ${JSON.stringify(res.issues)}`);
      assert.ok(res.issues.some((issue) => issue.code === code), `${name}: ${JSON.stringify(res.issues)}`);
    }
  });

  it("rejects v2 previews with an invalid distribution policy", async () => {
    const res = await validateExportPackage(join(fixtures, "invalid-v2-preview-distribution.zip"));
    assert.equal(res.ok, false, JSON.stringify(res.issues));
    assert.ok(res.issues.some((issue) => issue.code === "PREVIEW_DISTRIBUTION_INVALID"));
  });

  it("rejects v2 credentials, sensitive names, and default-included subtitles", async () => {
    const cases = [
      ["invalid-v2-auth.zip", "DANGEROUS_ASSET_FORBIDDEN"],
      ["invalid-v2-sensitive-name.zip", "DANGEROUS_ASSET_FORBIDDEN"],
      ["invalid-v2-subtitle-default.zip", "SUBTITLE_DEFAULT_INCLUDE"]
    ] as const;
    for (const [name, code] of cases) {
      const res = await validateExportPackage(join(fixtures, name));
      assert.equal(res.ok, false, `${name}: ${JSON.stringify(res.issues)}`);
      assert.ok(res.issues.some((issue) => issue.code === code), `${name}: ${JSON.stringify(res.issues)}`);
    }
  });

  it("rejects source URLs and local paths from untrusted v2 package metadata", async () => {
    for (const name of ["invalid-v2-source-url.zip", "invalid-v2-local-path.zip", "invalid-v2-password.zip"]) {
      const res = await validateExportPackage(join(fixtures, name));
      assert.equal(res.ok, false, `${name}: ${JSON.stringify(res.issues)}`);
      assert.ok(res.issues.some((issue) => issue.code === "SENSITIVE_REFERENCE"), `${name}: ${JSON.stringify(res.issues)}`);
    }
  });

  it("rejects ZIP entries that are not declared by the v2 manifest", async () => {
    const res = await validateExportPackage(join(fixtures, "invalid-v2-undeclared-entry.zip"));
    assert.equal(res.ok, false, JSON.stringify(res.issues));
    assert.ok(res.issues.some((issue) => issue.code === "ZIP_UNDECLARED_ENTRY"));
  });

  it("rejects wrong schema version", async () => {
    const res = await validateExportPackage(join(fixtures, "invalid-schema.zip"));
    assert.equal(res.ok, false);
    assert.ok(
      res.issues.some((i) => i.code === "SCHEMA" || i.code === "SCHEMA_VERSION")
    );
  });

  it("rejects zip slip / unsafe paths", async () => {
    const res = await validateExportPackage(join(fixtures, "invalid-zipslip.zip"));
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code.startsWith("PATH_") || i.code === "FILE_PATH_PREFIX" || i.code === "PATH_ESCAPE"));
  });

  it("rejects packages whose uncompressed entries exceed the configured limit", async () => {
    const res = await validateExportPackage(join(fixtures, "valid-basic.zip"), {
      maxPackageBytes: 1024 * 1024,
      maxUncompressedBytes: 1
    });
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code === "PACKAGE_UNCOMPRESSED_TOO_LARGE"));
  });
});

describe("readV1PackageMetadata", () => {
  ensureFixtures();

  it("validates v1 metadata without loading file contents", async () => {
    const res = await readV1PackageMetadata(join(fixtures, "valid-basic.zip"));
    assert.equal(res.ok, true, JSON.stringify(res.issues));
    assert.equal(res.manifest?.schema_version, "resource-gallery.export/v1");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { validateExportPackage, assertSafePackagePath } from "./validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

function ensureFixtures() {
  const needed = [
    "valid-basic.zip",
    "valid-design.zip",
    "valid-product.zip",
    "invalid-all-video.zip",
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
  });
  it("accepts normal files path", () => {
    assert.equal(assertSafePackagePath("files/deck.pdf"), null);
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

  it("rejects all-video package after strip", async () => {
    const res = await validateExportPackage(join(fixtures, "invalid-all-video.zip"));
    assert.equal(res.ok, false);
    assert.ok(res.issues.some((i) => i.code === "NO_USABLE_FILES"));
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
});

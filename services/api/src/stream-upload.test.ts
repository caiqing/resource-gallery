import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MultipartUploadError, streamZipMultipartUpload } from "./lib/stream-upload.js";

const root = join(tmpdir(), `resource-gallery-stream-upload-${process.pid}`);

function multipartRequest(name: string, content: Uint8Array<ArrayBuffer>): Request {
  const form = new FormData();
  form.append("file", new Blob([content.buffer], { type: "application/zip" }), name);
  return new Request("http://gallery.test/api/admin/import-jobs", { method: "POST", body: form });
}

after(() => rmSync(root, { recursive: true, force: true }));

describe("streamZipMultipartUpload", () => {
  it("streams a multipart ZIP to disk without materializing its File", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]);
    const target = join(root, "ok.zip");
    const uploaded = await streamZipMultipartUpload(multipartRequest("overview.zip", bytes), target, 64);
    assert.equal(uploaded.filename, "overview.zip");
    assert.equal(uploaded.sizeBytes, bytes.byteLength);
    assert.deepEqual(readFileSync(target), Buffer.from(bytes));
  });

  it("rejects an oversized stream and removes its partial temporary file", async () => {
    const target = join(root, "too-large.zip");
    await assert.rejects(
      () => streamZipMultipartUpload(multipartRequest("overview.zip", new Uint8Array(9)), target, 8),
      (error: unknown) => error instanceof MultipartUploadError && error.status === 413
    );
    assert.equal(existsSync(target), false);
  });

  it("rejects a non-ZIP file and does not leave a temporary upload", async () => {
    const target = join(root, "not-zip.zip");
    await assert.rejects(
      () => streamZipMultipartUpload(multipartRequest("overview.mp4", new Uint8Array([1])), target, 64),
      (error: unknown) => error instanceof MultipartUploadError && error.status === 400
    );
    assert.equal(existsSync(target), false);
  });
});

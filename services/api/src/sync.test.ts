import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ??= "sync-test-session-secret-012345678901234567890123";
process.env.DOWNLOAD_SIGNING_SECRET ??= "sync-test-download-secret-012345678901234567890123";

const { evaluateAutoPublishGate } = await import("./lib/sync.js");

const asset = (id: string, kind = "content", included = 1, stripped = 0) => ({
  upstream_asset_id: id,
  kind,
  included,
  stripped
});

describe("auto publish gate", () => {
  it("allows an unchanged core set and ignores removed stripped assets", () => {
    const result = evaluateAutoPublishGate(
      [asset("core-a"), asset("core-b"), asset("old-source", "video", 0, 1)],
      [asset("core-a"), asset("core-b"), asset("preview", "preview_audio", 0)],
      0
    );
    assert.deepEqual(result, { ok: true, removedCount: 0, coreCountBefore: 2, coreCountAfter: 2 });
  });

  it("blocks removals above the configured threshold before publishing", () => {
    const result = evaluateAutoPublishGate([asset("core-a"), asset("core-b")], [asset("core-a")], 0);
    assert.equal(result.ok, false);
    assert.equal(result.code, "REMOVED_ASSETS_EXCEED_LIMIT");
    assert.equal(result.removedCount, 1);
    assert.deepEqual([result.coreCountBefore, result.coreCountAfter], [2, 1]);
  });

  it("still blocks a core decrease when the removal threshold permits it", () => {
    const result = evaluateAutoPublishGate([asset("core-a"), asset("core-b")], [asset("core-a")], 1);
    assert.equal(result.ok, false);
    assert.equal(result.code, "CORE_ASSETS_DECREASED");
  });

  it("blocks drafts with no included safe asset", () => {
    const result = evaluateAutoPublishGate([asset("core-a")], [asset("core-a", "content", 0)], 0);
    assert.equal(result.ok, false);
    assert.equal(result.code, "NO_INCLUDED_ASSETS");
  });
});

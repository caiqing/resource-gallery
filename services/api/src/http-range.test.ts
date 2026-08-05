import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseByteRange } from "./lib/http-range.js";

describe("HTTP byte ranges", () => {
  it("supports explicit, open-ended, and suffix ranges", () => {
    assert.deepEqual(parseByteRange("bytes=2-5", 10), { start: 2, end: 5 });
    assert.deepEqual(parseByteRange("bytes=7-", 10), { start: 7, end: 9 });
    assert.deepEqual(parseByteRange("bytes=-3", 10), { start: 7, end: 9 });
    assert.deepEqual(parseByteRange("bytes=-99", 10), { start: 0, end: 9 });
  });

  it("rejects malformed, empty, and unsatisfiable ranges", () => {
    for (const value of ["bytes=", "bytes=-0", "bytes=10-", "bytes=8-2", "items=0-1", "bytes=0-1,2-3"]) {
      assert.equal(parseByteRange(value, 10), null, value);
    }
    assert.equal(parseByteRange("bytes=0-1", 0), null);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCanaryReport, evaluateSample, loadToken, parsePrometheusMetrics } from "./canary-watch.mjs";

describe("canary watch", () => {
  it("parses labelled and unlabelled Prometheus metrics", () => {
    const metrics = parsePrometheusMetrics([
      "# HELP ignored",
      'resource_gallery_sync_runs_total{status="failed"} 2',
      "resource_gallery_sync_gate_reviews_total 1",
      "resource_gallery_sync_review_oldest_age_seconds 12.5"
    ].join("\n"));
    assert.equal(metrics.get('resource_gallery_sync_runs_total{status="failed"}'), 2);
    assert.equal(metrics.get("resource_gallery_sync_gate_reviews_total"), 1);
    assert.equal(metrics.get("resource_gallery_sync_review_oldest_age_seconds"), 12.5);
  });

  it("does not fail when counters remain at their baseline", () => {
    const sample = { healthOk: true, failedRuns: 0, failedStates: 0, failedImports: 0, gateReviews: 0, reviewOldestAge: 20 };
    assert.deepEqual(evaluateSample(sample, sample), []);
  });

  it("fails on new failures, gate blocks, unhealthy API, or stale review", () => {
    const baseline = { healthOk: true, failedRuns: 1, failedStates: 2, failedImports: 3, gateReviews: 0, reviewOldestAge: 10 };
    const failures = evaluateSample({
      healthOk: false,
      failedRuns: 2,
      failedStates: 2,
      failedImports: 4,
      gateReviews: 1,
      reviewOldestAge: 100
    }, baseline, 60);
    assert.equal(failures.length, 5);
  });

  it("requires three distinct successful canary profiles", () => {
    const report = [
      { task_id: "task-audio", status: "review", canary_profile: "audio" },
      { task_id: "task-video", status: "published", canary_profile: "video" },
      { task_id: "task-mixed", status: "unchanged", canary_profile: "mixed" }
    ].map((row) => JSON.stringify(row)).join("\n");
    assert.deepEqual(evaluateCanaryReport(report), {
      ok: true,
      failures: [],
      profiles: { audio: "task-audio", video: "task-video", mixed: "task-mixed" }
    });
  });

  it("accepts evidence combined from separate task reports", () => {
    const reports = [
      { task_id: "task-audio", status: "review", canary_profile: "audio" },
      { task_id: "task-video", status: "review", canary_profile: "video" },
      { task_id: "task-mixed", status: "review", canary_profile: "mixed" }
    ].map((row) => JSON.stringify(row));
    assert.equal(evaluateCanaryReport(reports.join("\n")).ok, true);
  });

  it("rejects incomplete or reused canary evidence", () => {
    const result = evaluateCanaryReport([
      JSON.stringify({ task_id: "same-task", status: "review", canary_profile: "audio" }),
      JSON.stringify({ task_id: "same-task", status: "review", canary_profile: "video" }),
      "not-json"
    ].join("\n"));
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 3);
    assert.match(result.failures[0], /报告第 3 行/);
    assert.match(result.failures[1], /同一个 task_id/);
    assert.match(result.failures[2], /缺少 mixed/);
  });

  it("loads a token only from a private regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "resource-gallery-canary-watch-"));
    const tokenFile = join(root, "token");
    const tokenLink = join(root, "token-link");
    try {
      writeFileSync(tokenFile, "test-token\n", { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
      assert.equal(loadToken(tokenFile), "test-token");

      chmodSync(tokenFile, 0o640);
      assert.throws(() => loadToken(tokenFile), /0600/);

      chmodSync(tokenFile, 0o600);
      symlinkSync(tokenFile, tokenLink);
      assert.throws(() => loadToken(tokenLink), /符号链接/);
      assert.throws(() => loadToken(""), /--token-file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

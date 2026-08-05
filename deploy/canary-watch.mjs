#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_REVIEW_MAX_AGE = 24 * 60 * 60;

function parseArgs(argv) {
  const args = {
    baseUrl: "",
    tokenFile: "",
    intervalSeconds: 60,
    durationSeconds: 24 * 60 * 60,
    maxReviewAge: DEFAULT_REVIEW_MAX_AGE,
    canaryReports: [],
    once: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") args.baseUrl = argv[++index];
    else if (arg === "--token-file") args.tokenFile = argv[++index];
    else if (arg === "--interval-seconds") args.intervalSeconds = Number(argv[++index]);
    else if (arg === "--duration-seconds") args.durationSeconds = Number(argv[++index]);
    else if (arg === "--max-review-age-seconds") args.maxReviewAge = Number(argv[++index]);
    else if (arg === "--canary-report") args.canaryReports.push(argv[++index]);
    else if (arg === "--once") args.once = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return args;
}

function metricKey(name, labels) {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return name;
  return `${name}{${keys.map((key) => `${key}="${labels[key]}"`).join(",")}}`;
}

export function parsePrometheusMetrics(text) {
  const metrics = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/.exec(line.trim());
    if (!match) continue;
    const labels = {};
    for (const label of match[2]?.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g) ?? []) {
      labels[label[1]] = label[2].replaceAll('\\"', '"').replaceAll('\\\\', '\\');
    }
    metrics.set(metricKey(match[1], labels), Number(match[3]));
  }
  return metrics;
}

function metric(metrics, name, labels = {}) {
  return metrics.get(metricKey(name, labels)) ?? 0;
}

export function evaluateSample(sample, baseline, maxReviewAge = DEFAULT_REVIEW_MAX_AGE) {
  const failures = [];
  if (!sample.healthOk) failures.push("health endpoint 非 2xx");
  const counters = [
    ["失败同步运行", "failedRuns"],
    ["失败同步任务", "failedStates"],
    ["失败导入任务", "failedImports"],
    ["自动发布门禁异常", "gateReviews"]
  ];
  for (const [label, key] of counters) {
    if (sample[key] > baseline[key]) failures.push(`${label}计数增加 (${baseline[key]} -> ${sample[key]})`);
  }
  if (sample.reviewOldestAge > maxReviewAge) {
    failures.push(`最早 review 已超过 ${maxReviewAge} 秒`);
  }
  return failures;
}

export function evaluateCanaryReport(text) {
  const required = ["audio", "video", "mixed"];
  const profiles = new Map();
  const failures = [];
  for (const [index, raw] of String(text).split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    let row;
    try {
      row = JSON.parse(raw);
    } catch {
      failures.push(`金丝雀报告第 ${index + 1} 行不是合法 JSON`);
      continue;
    }
    if (!["review", "published", "unchanged"].includes(row.status)) continue;
    if (!required.includes(row.canary_profile) || !String(row.task_id || "").trim()) continue;
    if (!profiles.has(row.canary_profile)) profiles.set(row.canary_profile, String(row.task_id));
  }
  const usedTasks = new Map();
  for (const profile of required) {
    const taskId = profiles.get(profile);
    if (!taskId) {
      failures.push(`缺少 ${profile} 金丝雀成功同步证据`);
      continue;
    }
    const previous = usedTasks.get(taskId);
    if (previous) failures.push(`${profile} 与 ${previous} 使用了同一个 task_id: ${taskId}`);
    usedTasks.set(taskId, profile);
  }
  return {
    ok: failures.length === 0,
    failures,
    profiles: Object.fromEntries([...profiles.entries()])
  };
}

async function sample(baseUrl, token) {
  const root = String(baseUrl).replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}` };
  const health = await fetch(`${root}/health`);
  const metricsResponse = await fetch(`${root}/api/sync/metrics`, { headers });
  if (!metricsResponse.ok) throw new Error(`metrics endpoint 返回 HTTP ${metricsResponse.status}`);
  const metrics = parsePrometheusMetrics(await metricsResponse.text());
  return {
    healthOk: health.ok,
    failedRuns: metric(metrics, "resource_gallery_sync_runs_total", { status: "failed" }),
    failedStates: metric(metrics, "resource_gallery_sync_states_total", { status: "failed" }),
    failedImports: metric(metrics, "resource_gallery_import_jobs_total", { status: "failed" }),
    gateReviews: metric(metrics, "resource_gallery_sync_gate_reviews_total"),
    reviewOldestAge: metric(metrics, "resource_gallery_sync_review_oldest_age_seconds")
  };
}

export function loadToken(tokenFile) {
  if (!tokenFile) throw new Error("必须提供 --token-file；不要从环境变量或 .env 读取同步令牌");
  const path = resolve(tokenFile);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("同步令牌必须是常规文件，不能使用符号链接");
  }
  if (stat.mode & 0o077) {
    throw new Error("同步令牌文件权限必须为 0600 或更严格");
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error("同步令牌文件为空");
  return token;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function run(args, output = console) {
  if (!args.baseUrl) throw new Error("必须提供 --base-url");
  if (!Number.isFinite(args.intervalSeconds) || args.intervalSeconds <= 0) throw new Error("--interval-seconds 必须为正数");
  if (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0) throw new Error("--duration-seconds 必须为正数");
  const token = loadToken(args.tokenFile);
  let canaryEvidence;
  if (args.canaryReports.length) {
    const reports = args.canaryReports.map((report) => readFileSync(resolve(report), "utf8"));
    canaryEvidence = evaluateCanaryReport(reports.join("\n"));
    if (!canaryEvidence.ok) throw new Error(canaryEvidence.failures.join("；"));
  }
  const first = await sample(args.baseUrl, token);
  const baseline = { ...first };
  const startedAt = Date.now();
  for (;;) {
    const current = await sample(args.baseUrl, token);
    const failures = evaluateSample(current, baseline, args.maxReviewAge);
    output.log(JSON.stringify({
      checked_at: new Date().toISOString(),
      health_ok: current.healthOk,
      failed_runs: current.failedRuns,
      failed_states: current.failedStates,
      failed_imports: current.failedImports,
      gate_reviews: current.gateReviews,
      review_oldest_age_seconds: current.reviewOldestAge,
      canary_profiles: canaryEvidence?.profiles,
      failures
    }));
    if (failures.length) return 1;
    if (args.once || Date.now() - startedAt >= args.durationSeconds * 1000) return 0;
    await sleep(args.intervalSeconds * 1000);
  }
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log("用法: node deploy/canary-watch.mjs --base-url https://gallery.example.com --token-file /etc/resource-gallery/sync-token [--canary-report /path/sync.jsonl ...] [--once]");
      process.exitCode = 0;
    } else {
      process.exitCode = await run(args);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Canary Watch failed");
    process.exitCode = 2;
  }
}

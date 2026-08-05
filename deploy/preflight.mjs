#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLACEHOLDER_RE = /^(?:replace-with-|change-me|your-|<|\$\{|TODO|CHANGEME)/i;

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function isPlaceholder(value) {
  return !String(value ?? "").trim() || PLACEHOLDER_RE.test(String(value).trim());
}

function addRequired(errors, values, key) {
  if (isPlaceholder(values[key])) errors.push(`${key} 未配置或仍为占位值`);
}

function addSecret(errors, values, key) {
  addRequired(errors, values, key);
  if (!isPlaceholder(values[key]) && String(values[key]).length < 32) {
    errors.push(`${key} 长度不足 32 个字符`);
  }
}

function validateOrigin(errors, values) {
  const origin = String(values.PUBLIC_ORIGIN ?? "").trim();
  const site = String(values.SITE_ADDRESS ?? "").trim();
  if (isPlaceholder(origin)) {
    errors.push("PUBLIC_ORIGIN 未配置或仍为占位值");
    return;
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    errors.push("PUBLIC_ORIGIN 不是合法 URL");
    return;
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    errors.push("PUBLIC_ORIGIN 只能包含协议、主机和可选端口");
  }
  if (values.__mode === "production" || values.__mode === "production-review") {
    if (parsed.protocol !== "https:") errors.push("生产 PUBLIC_ORIGIN 必须使用 HTTPS");
    if (!site || site.includes("://") || /[\\/\s]/.test(site)) {
      errors.push("生产 SITE_ADDRESS 必须是裸域名，不得包含协议、路径或空格");
    } else if (site.split(":")[0].toLowerCase() !== parsed.hostname.toLowerCase()) {
      errors.push("SITE_ADDRESS 必须与 PUBLIC_ORIGIN 主机一致");
    }
  }
}

export function validateConfig(input, mode = "production") {
  const values = { ...input, __mode: mode };
  const errors = [];
  const required = [
    "PUBLIC_ORIGIN",
    "SITE_ADDRESS",
    "INITIAL_ADMIN_EMAIL",
    "INITIAL_ADMIN_PASSWORD"
  ];
  for (const key of required) addRequired(errors, values, key);
  validateOrigin(errors, values);
  addSecret(errors, values, "SESSION_SECRET");
  addSecret(errors, values, "DOWNLOAD_SIGNING_SECRET");
  if (
    !isPlaceholder(values.SESSION_SECRET) &&
    !isPlaceholder(values.DOWNLOAD_SIGNING_SECRET) &&
    values.SESSION_SECRET === values.DOWNLOAD_SIGNING_SECRET
  ) {
    errors.push("SESSION_SECRET 与 DOWNLOAD_SIGNING_SECRET 必须不同");
  }
  if (!isPlaceholder(values.INITIAL_ADMIN_EMAIL) && !/^[^@\s]+@[^@\s]+$/.test(values.INITIAL_ADMIN_EMAIL)) {
    errors.push("INITIAL_ADMIN_EMAIL 不是合法邮箱");
  }
  if (!isPlaceholder(values.INITIAL_ADMIN_PASSWORD) && String(values.INITIAL_ADMIN_PASSWORD).length < 16) {
    errors.push("INITIAL_ADMIN_PASSWORD 长度不足 16 个字符");
  }

  if (mode === "production" || mode === "production-review") {
    if (String(values.NODE_ENV ?? "production") !== "production") errors.push("NODE_ENV 必须为 production");
    if (String(values.BLOB_STORAGE_BACKEND ?? "").toLowerCase() !== "s3") {
      errors.push("生产 BLOB_STORAGE_BACKEND 必须为 s3");
    }
    for (const key of ["BLOB_S3_BUCKET", "BLOB_S3_REGION", "BLOB_S3_PREFIX"]) addRequired(errors, values, key);
    const accessKey = String(values.AWS_ACCESS_KEY_ID ?? "").trim();
    const secretKey = String(values.AWS_SECRET_ACCESS_KEY ?? "").trim();
    if (Boolean(accessKey) !== Boolean(secretKey)) errors.push("AWS_ACCESS_KEY_ID 与 AWS_SECRET_ACCESS_KEY 必须同时配置或同时留空");
    if (mode === "production" && String(values.RESOURCE_GALLERY_SYNC_ENABLED ?? "false").toLowerCase() !== "false") {
      errors.push("生产基础部署必须保持 RESOURCE_GALLERY_SYNC_ENABLED=false");
    }
    if (mode === "production-review") {
      if (String(values.RESOURCE_GALLERY_SYNC_ENABLED ?? "").toLowerCase() !== "true") errors.push("production-review 必须启用机器同步");
      addSecret(errors, values, "RESOURCE_GALLERY_SYNC_TOKEN");
      addRequired(errors, values, "RESOURCE_GALLERY_SYNC_ACTOR_EMAIL");
      if (String(values.RESOURCE_GALLERY_SYNC_MAX_REMOVED_FILES ?? "0") !== "0") errors.push("金丝雀阶段 RESOURCE_GALLERY_SYNC_MAX_REMOVED_FILES 必须为 0");
    }
  } else if (mode !== "local") {
    errors.push(`不支持的模式: ${mode}`);
  }

  return errors;
}

function parseArgs(argv) {
  const args = { envFile: "deploy/.env", mode: "production" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file") args.envFile = argv[++index];
    else if (arg === "--mode") args.mode = argv[++index];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2), output = console) {
  const args = parseArgs(argv);
  if (args.help) {
    output.log("用法: node deploy/preflight.mjs [--env-file deploy/.env] [--mode production|production-review|local]");
    return 0;
  }
  const envPath = resolve(args.envFile);
  let values;
  try {
    values = parseDotEnv(readFileSync(envPath, "utf8"));
  } catch {
    output.error(`无法读取配置文件: ${args.envFile}`);
    return 2;
  }
  const errors = validateConfig(values, args.mode);
  output.log(`Resource Gallery preflight: mode=${args.mode}`);
  if (errors.length) {
    for (const error of errors) output.error(`FAIL ${error}`);
    output.error(`检查失败: ${errors.length} 项`);
    return 1;
  }
  output.log("PASS 配置形状与安全门槛通过；尚未验证 DNS、TLS 证书、S3 连通性或 IAM 权限");
  return 0;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) process.exitCode = main();

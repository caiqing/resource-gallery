import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

export type SummaryLlmSettings = {
  enabled: boolean;
  provider: string;
  apiBase: string;
  apiKey: string;
  model: string;
  fallbackModels: string[];
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
};

export type PublicSummaryLlmSettings = Omit<SummaryLlmSettings, "apiKey"> & {
  apiKeyConfigured: boolean;
  apiKey: "";
};

export type SummaryLlmSettingsUpdate = Omit<SummaryLlmSettings, "apiKey"> & {
  apiKey?: string | null;
};

const ENV_KEYS = {
  enabled: "SUMMARY_LLM_ENABLED",
  provider: "SUMMARY_LLM_PROVIDER",
  apiBase: "SUMMARY_LLM_BASE_URL",
  apiKey: "SUMMARY_LLM_API_KEY",
  model: "SUMMARY_LLM_MODEL",
  fallbackModels: "SUMMARY_LLM_FALLBACK_MODELS",
  timeoutMs: "SUMMARY_LLM_TIMEOUT_MS",
  temperature: "SUMMARY_LLM_TEMPERATURE",
  maxTokens: "SUMMARY_LLM_MAX_TOKENS"
} as const;

export function getSummaryLlmSettings(): SummaryLlmSettings {
  return {
    enabled: config.summaryLlmEnabled,
    provider: config.summaryLlmProvider,
    apiBase: config.summaryLlmBaseUrl,
    apiKey: config.summaryLlmApiKey,
    model: config.summaryLlmModel,
    fallbackModels: [...config.summaryLlmFallbackModels],
    timeoutMs: config.summaryLlmTimeoutMs,
    temperature: config.summaryLlmTemperature,
    maxTokens: config.summaryLlmMaxTokens
  };
}

export function publicSummaryLlmSettings(): PublicSummaryLlmSettings {
  const { apiKey, ...settings } = getSummaryLlmSettings();
  return { ...settings, apiKeyConfigured: Boolean(apiKey), apiKey: "" };
}

export function summaryLlmOptions(overrides: {
  apiBase?: string;
  apiKey?: string;
  timeoutMs?: number;
} = {}) {
  const settings = getSummaryLlmSettings();
  const apiBase = overrides.apiBase == null
    ? settings.apiBase
    : validateHttpUrl(safeEnvValue(overrides.apiBase, "模型 API 地址"));
  const incomingApiKey = overrides.apiKey?.trim() ?? "";
  if (incomingApiKey.length > 8192) throw new Error("API Key 过长");
  const apiKey = incomingApiKey
    ? safeEnvValue(overrides.apiKey ?? "", "API Key").trim()
    : settings.apiKey;
  const requestedTimeout = overrides.timeoutMs == null ? settings.timeoutMs : Number(overrides.timeoutMs);
  if (!Number.isFinite(requestedTimeout)) throw new Error("模型超时必须是有效数字");
  return {
    enabled: settings.enabled,
    baseUrl: apiBase,
    apiKey,
    model: settings.model,
    fallbackModels: settings.fallbackModels,
    timeoutMs: Math.max(1_000, Math.min(300_000, Math.round(requestedTimeout))),
    temperature: settings.temperature,
    maxTokens: settings.maxTokens
  };
}

export function summaryLlmConfigured(): boolean {
  const settings = getSummaryLlmSettings();
  return Boolean(settings.enabled && settings.apiBase && settings.apiKey && settings.model);
}

function cleanModels(values: string[]): string[] {
  const models = values.map((value) => safeEnvValue(value, "备用模型").trim()).filter(Boolean);
  if (models.some((value) => value.length > 200)) throw new Error("备用模型名称过长");
  return [...new Set(models)].slice(0, 20);
}

function safeEnvValue(value: string, label: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error(`${label}不能包含换行或空字符`);
  return value;
}

function validateHttpUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (normalized.length > 2048) throw new Error("模型 API 地址过长");
  const url = new URL(normalized);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("模型 API 地址只允许 HTTP/HTTPS");
  return normalized;
}

export function normalizeSummaryLlmSettings(
  input: SummaryLlmSettingsUpdate,
  current = getSummaryLlmSettings()
): SummaryLlmSettings {
  const provider = safeEnvValue(input.provider, "模型服务名称").trim();
  const model = safeEnvValue(input.model, "主模型名称").trim();
  if (!provider || provider.length > 80) throw new Error("模型服务名称无效");
  if (!model || model.length > 200) throw new Error("主模型名称无效");
  const incomingApiKey = input.apiKey?.trim() ?? "";
  if (incomingApiKey.length > 8192) throw new Error("API Key 过长");
  const apiKey = incomingApiKey
    ? safeEnvValue(input.apiKey ?? "", "API Key").trim()
    : current.apiKey;
  const timeoutMs = Number(input.timeoutMs);
  const temperature = Number(input.temperature);
  const maxTokens = Number(input.maxTokens);
  if (![timeoutMs, temperature, maxTokens].every(Number.isFinite)) {
    throw new Error("模型生成参数必须是有效数字");
  }
  return {
    enabled: Boolean(input.enabled),
    provider,
    apiBase: validateHttpUrl(input.apiBase),
    apiKey,
    model,
    fallbackModels: cleanModels(input.fallbackModels).filter((item) => item !== model),
    timeoutMs: Math.max(1_000, Math.min(300_000, Math.round(timeoutMs))),
    temperature: Math.max(0, Math.min(2, temperature)),
    maxTokens: Math.max(32, Math.min(8_192, Math.round(maxTokens)))
  };
}

function writeEnvValues(path: string, values: Record<string, string>): void {
  const serialized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, envLiteral(value)])
  );
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    const key = match?.[1];
    if (!key || !(key in serialized)) return line;
    seen.add(key);
    return `${key}=${serialized[key]}`;
  });
  if (next.length && next.at(-1)?.trim()) next.push("");
  for (const [key, value] of Object.entries(serialized)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  const content = `${next.join("\n").replace(/\n+$/, "")}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function envLiteral(value: string): string {
  if (/^[A-Za-z0-9_./:@%+?&=,-]*$/.test(value)) return value;
  return JSON.stringify(value);
}

export function updateSummaryLlmSettings(input: SummaryLlmSettingsUpdate): PublicSummaryLlmSettings {
  const settings = normalizeSummaryLlmSettings(input);
  const values = {
    [ENV_KEYS.enabled]: settings.enabled ? "1" : "0",
    [ENV_KEYS.provider]: settings.provider,
    [ENV_KEYS.apiBase]: settings.apiBase,
    [ENV_KEYS.apiKey]: settings.apiKey,
    [ENV_KEYS.model]: settings.model,
    [ENV_KEYS.fallbackModels]: settings.fallbackModels.join(","),
    [ENV_KEYS.timeoutMs]: String(settings.timeoutMs),
    [ENV_KEYS.temperature]: String(settings.temperature),
    [ENV_KEYS.maxTokens]: String(settings.maxTokens)
  };
  writeEnvValues(config.envFilePath, values);
  Object.assign(config, {
    summaryLlmEnabled: settings.enabled,
    summaryLlmProvider: settings.provider,
    summaryLlmBaseUrl: settings.apiBase,
    summaryLlmApiKey: settings.apiKey,
    summaryLlmModel: settings.model,
    summaryLlmFallbackModels: settings.fallbackModels,
    summaryLlmTimeoutMs: settings.timeoutMs,
    summaryLlmTemperature: settings.temperature,
    summaryLlmMaxTokens: settings.maxTokens
  });
  Object.entries(values).forEach(([key, value]) => {
    process.env[key] = value;
  });
  return publicSummaryLlmSettings();
}

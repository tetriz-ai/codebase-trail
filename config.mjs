// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { readFile } from "node:fs/promises";
import path from "node:path";

export const CONFIG_VERSION = 1;

const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  source: Object.freeze({ provider: "local-git", checkout: ".", repository: null, hostname: null }),
  model: Object.freeze({
    provider: "openai-compatible", endpoint: "http://127.0.0.1:11434/v1", model: "local-model",
    apiKeyEnv: "OPENAI_API_KEY", timeoutMs: 60_000, jsonSchema: "auto",
    maxOutputTokens: 4_096, retryMaxOutputTokens: 8_192, reasoningEffort: null,
    contextWindowTokens: null, maxCompletionTokens: null,
    tokenParameter: "auto", temperatureMode: "auto", systemInstructionMode: "system", authMode: "auto", sourceEgress: "auto", reasoningMode: "auto",
    reviewProvider: null, reviewEndpoint: null, reviewModel: null, reviewApiKeyEnv: null, reviewAuthMode: null,
    reviewTimeoutMs: null, reviewJsonSchema: null, reviewMaxOutputTokens: null, reviewRetryMaxOutputTokens: null,
    reviewContextWindowTokens: null, reviewMaxCompletionTokens: null, reviewTokenParameter: null,
    reviewTemperatureMode: null, reviewSystemInstructionMode: null, reviewReasoningMode: null,
    reviewReasoningEffort: null, reviewSourceEgress: null,
  }),
});

const SHAPE = {
  version: true,
  source: { provider: true, checkout: true, repository: true, hostname: true },
  model: { provider: true, endpoint: true, model: true, apiKeyEnv: true, timeoutMs: true, jsonSchema: true, maxOutputTokens: true, retryMaxOutputTokens: true, reasoningEffort: true, reasoningMode: true, contextWindowTokens: true, maxCompletionTokens: true, tokenParameter: true, temperatureMode: true, systemInstructionMode: true, authMode: true, sourceEgress: true, reviewProvider: true, reviewEndpoint: true, reviewModel: true, reviewApiKeyEnv: true, reviewAuthMode: true, reviewTimeoutMs: true, reviewJsonSchema: true, reviewMaxOutputTokens: true, reviewRetryMaxOutputTokens: true, reviewContextWindowTokens: true, reviewMaxCompletionTokens: true, reviewTokenParameter: true, reviewTemperatureMode: true, reviewSystemInstructionMode: true, reviewReasoningMode: true, reviewReasoningEffort: true, reviewSourceEgress: true },
};

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`);
}

function rejectUnknown(value, shape, trail = "config") {
  plainObject(value, trail);
  for (const [key, entry] of Object.entries(value)) {
    if (!(key in shape)) throw new Error(`Unknown configuration key: ${trail}.${key}`);
    if (shape[key] !== true) rejectUnknown(entry, shape[key], `${trail}.${key}`);
  }
}

function merge(base, overlay) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object"
      ? merge(base[key], value) : value;
  }
  return result;
}

function envOverlay(env) {
  const source = {};
  const model = {};
  const mappings = [
    ["CODE_LEARNING_SOURCE_PROVIDER", source, "provider"], ["CODE_LEARNING_CHECKOUT", source, "checkout"],
    ["CODE_LEARNING_GITHUB_REPOSITORY", source, "repository"], ["CODE_LEARNING_GITHUB_HOSTNAME", source, "hostname"],
    ["CODE_LEARNING_MODEL_PROVIDER", model, "provider"], ["CODE_LEARNING_MODEL_ENDPOINT", model, "endpoint"],
    ["CODE_LEARNING_MODEL", model, "model"], ["CODE_LEARNING_MODEL_API_KEY_ENV", model, "apiKeyEnv"],
    ["CODE_LEARNING_MODEL_JSON_SCHEMA", model, "jsonSchema"],
    ["CODE_LEARNING_MODEL_REASONING_EFFORT", model, "reasoningEffort"],
    ["CODE_LEARNING_MODEL_TOKEN_PARAMETER", model, "tokenParameter"],
    ["CODE_LEARNING_MODEL_TEMPERATURE_MODE", model, "temperatureMode"],
    ["CODE_LEARNING_MODEL_SYSTEM_INSTRUCTION_MODE", model, "systemInstructionMode"],
    ["CODE_LEARNING_MODEL_AUTH_MODE", model, "authMode"],
    ["CODE_LEARNING_MODEL_SOURCE_EGRESS", model, "sourceEgress"],
    ["CODE_LEARNING_MODEL_REASONING_MODE", model, "reasoningMode"],
    ["CODE_LEARNING_REVIEW_MODEL_PROVIDER", model, "reviewProvider"],
    ["CODE_LEARNING_REVIEW_MODEL_ENDPOINT", model, "reviewEndpoint"],
    ["CODE_LEARNING_REVIEW_MODEL", model, "reviewModel"],
    ["CODE_LEARNING_REVIEW_MODEL_API_KEY_ENV", model, "reviewApiKeyEnv"],
    ["CODE_LEARNING_REVIEW_MODEL_AUTH_MODE", model, "reviewAuthMode"],
    ["CODE_LEARNING_REVIEW_MODEL_JSON_SCHEMA", model, "reviewJsonSchema"],
    ["CODE_LEARNING_REVIEW_MODEL_TOKEN_PARAMETER", model, "reviewTokenParameter"],
    ["CODE_LEARNING_REVIEW_MODEL_TEMPERATURE_MODE", model, "reviewTemperatureMode"],
    ["CODE_LEARNING_REVIEW_MODEL_SYSTEM_INSTRUCTION_MODE", model, "reviewSystemInstructionMode"],
    ["CODE_LEARNING_REVIEW_MODEL_REASONING_MODE", model, "reviewReasoningMode"],
    ["CODE_LEARNING_REVIEW_MODEL_REASONING_EFFORT", model, "reviewReasoningEffort"],
    ["CODE_LEARNING_REVIEW_MODEL_SOURCE_EGRESS", model, "reviewSourceEgress"],
  ];
  for (const [name, target, key] of mappings) if (env[name] !== undefined) target[key] = env[name];
  // Compatibility aliases for earlier configurations. New deployments should use
  // the CODE_LEARNING_* names so one documented namespace owns configuration.
  if (env.CODE_LEARNING_MODEL_ENDPOINT === undefined && env.LLM_BASE_URL !== undefined) model.endpoint = env.LLM_BASE_URL;
  if (env.CODE_LEARNING_MODEL === undefined && env.LLM_MODEL !== undefined) model.model = env.LLM_MODEL;
  if (env.CODE_LEARNING_MODEL_TIMEOUT_MS !== undefined) model.timeoutMs = Number(env.CODE_LEARNING_MODEL_TIMEOUT_MS);
  if (env.CODE_LEARNING_MODEL_MAX_OUTPUT_TOKENS !== undefined) model.maxOutputTokens = Number(env.CODE_LEARNING_MODEL_MAX_OUTPUT_TOKENS);
  if (env.CODE_LEARNING_MODEL_RETRY_MAX_OUTPUT_TOKENS !== undefined) model.retryMaxOutputTokens = Number(env.CODE_LEARNING_MODEL_RETRY_MAX_OUTPUT_TOKENS);
  if (env.CODE_LEARNING_MODEL_CONTEXT_WINDOW_TOKENS !== undefined) model.contextWindowTokens = Number(env.CODE_LEARNING_MODEL_CONTEXT_WINDOW_TOKENS);
  if (env.CODE_LEARNING_MODEL_MAX_COMPLETION_TOKENS !== undefined) model.maxCompletionTokens = Number(env.CODE_LEARNING_MODEL_MAX_COMPLETION_TOKENS);
  if (env.CODE_LEARNING_REVIEW_MODEL_TIMEOUT_MS !== undefined) model.reviewTimeoutMs = Number(env.CODE_LEARNING_REVIEW_MODEL_TIMEOUT_MS);
  if (env.CODE_LEARNING_REVIEW_MODEL_MAX_OUTPUT_TOKENS !== undefined) model.reviewMaxOutputTokens = Number(env.CODE_LEARNING_REVIEW_MODEL_MAX_OUTPUT_TOKENS);
  if (env.CODE_LEARNING_REVIEW_MODEL_RETRY_MAX_OUTPUT_TOKENS !== undefined) model.reviewRetryMaxOutputTokens = Number(env.CODE_LEARNING_REVIEW_MODEL_RETRY_MAX_OUTPUT_TOKENS);
  if (env.CODE_LEARNING_REVIEW_MODEL_CONTEXT_WINDOW_TOKENS !== undefined) model.reviewContextWindowTokens = Number(env.CODE_LEARNING_REVIEW_MODEL_CONTEXT_WINDOW_TOKENS);
  if (env.CODE_LEARNING_REVIEW_MODEL_MAX_COMPLETION_TOKENS !== undefined) model.reviewMaxCompletionTokens = Number(env.CODE_LEARNING_REVIEW_MODEL_MAX_COMPLETION_TOKENS);
  return { ...(Object.keys(source).length ? { source } : {}), ...(Object.keys(model).length ? { model } : {}) };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CLI_PROVIDERS = new Set(['claude-cli', 'codex-cli']);
const PROVIDER_ENDPOINTS = Object.freeze({ openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1", 'claude-cli': 'https://claude.cli.invalid', 'codex-cli': 'https://codex.cli.invalid' });
const PROVIDER_KEY_ENVS = Object.freeze({ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", vertex: "GOOGLE_CLOUD_ACCESS_TOKEN" });
const REVIEW_COMPATIBILITY_DEFAULTS = Object.freeze({
  reviewTimeoutMs: DEFAULT_CONFIG.model.timeoutMs,
  reviewJsonSchema: DEFAULT_CONFIG.model.jsonSchema,
  reviewMaxOutputTokens: DEFAULT_CONFIG.model.maxOutputTokens,
  reviewRetryMaxOutputTokens: DEFAULT_CONFIG.model.retryMaxOutputTokens,
  reviewContextWindowTokens: DEFAULT_CONFIG.model.contextWindowTokens,
  reviewMaxCompletionTokens: DEFAULT_CONFIG.model.maxCompletionTokens,
  reviewTokenParameter: DEFAULT_CONFIG.model.tokenParameter,
  reviewTemperatureMode: DEFAULT_CONFIG.model.temperatureMode,
  reviewSystemInstructionMode: DEFAULT_CONFIG.model.systemInstructionMode,
  reviewReasoningMode: DEFAULT_CONFIG.model.reasoningMode,
  reviewReasoningEffort: null,
  reviewSourceEgress: DEFAULT_CONFIG.model.sourceEgress,
});

function endpointUrl(value, label) {
  try {
    const endpoint = new URL(value);
    if (!new Set(["http:", "https:"]).has(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
    if (endpoint.protocol === "http:" && !LOOPBACK_HOSTS.has(endpoint.hostname)) throw new Error();
    return endpoint;
  } catch { throw new Error(`${label} must use HTTPS, or HTTP on loopback, without embedded credentials, query, or fragment`); }
}

function sameEndpoint(left, right) {
  return left.href.replace(/\/$/, "") === right.href.replace(/\/$/, "");
}

function resolveReviewer(config) {
  if (config.model.reviewProvider && config.model.reviewProvider !== config.model.provider && !config.model.reviewEndpoint) throw new Error("model.reviewEndpoint is required when model.reviewProvider differs from model.provider");
  const generatorEndpoint = endpointUrl(config.model.endpoint, "model.endpoint");
  const reviewerEndpoint = endpointUrl(config.model.reviewEndpoint ?? config.model.endpoint, "model.reviewEndpoint");
  const reviewProvider = config.model.reviewProvider ?? config.model.provider;
  const sharedEndpoint = sameEndpoint(generatorEndpoint, reviewerEndpoint) && reviewProvider === config.model.provider;
  const reviewModel = config.model.reviewModel ?? config.model.model;
  const sharedModel = sharedEndpoint && reviewModel === config.model.model;
  if (!sharedEndpoint) {
    if (config.model.reviewAuthMode === null) throw new Error("model.reviewAuthMode must be explicit when model.reviewEndpoint differs from model.endpoint");
    if (config.model.reviewAuthMode !== "none" && config.model.reviewApiKeyEnv === null) throw new Error("model.reviewApiKeyEnv must be explicit for an authenticated distinct review endpoint");
  }
  const inherited = {
    reviewTimeoutMs: config.model.timeoutMs, reviewJsonSchema: config.model.jsonSchema,
    reviewMaxOutputTokens: config.model.maxOutputTokens, reviewRetryMaxOutputTokens: config.model.retryMaxOutputTokens,
    reviewContextWindowTokens: config.model.contextWindowTokens, reviewMaxCompletionTokens: config.model.maxCompletionTokens,
    reviewTokenParameter: config.model.tokenParameter, reviewTemperatureMode: config.model.temperatureMode,
    reviewSystemInstructionMode: config.model.systemInstructionMode, reviewReasoningMode: config.model.reasoningMode,
    reviewReasoningEffort: config.model.reasoningEffort, reviewSourceEgress: config.model.sourceEgress,
  };
  // Transport credentials belong to the endpoint, but model capabilities do
  // not. Two models behind the same OpenAI-compatible base URL may have
  // different context limits, schema support, and reasoning conventions.
  const defaults = sharedModel ? inherited : REVIEW_COMPATIBILITY_DEFAULTS;
  const review = {};
  for (const [key, fallback] of Object.entries(defaults)) review[key] = config.model[key] ?? fallback;
  const effectiveReviewAuthMode = config.model.reviewAuthMode ?? config.model.authMode;
  return {
    ...config,
    model: {
      ...config.model, ...review, reviewProvider, reviewEndpoint: reviewerEndpoint.href.replace(/\/$/, ""),
      reviewModel,
      reviewAuthMode: effectiveReviewAuthMode,
      reviewApiKeyEnv: effectiveReviewAuthMode === "none" ? null : config.model.reviewApiKeyEnv ?? (sharedEndpoint ? config.model.apiKeyEnv : null),
    },
  };
}

function validate(config) {
  rejectUnknown(config, SHAPE);
  if (config.version !== CONFIG_VERSION) throw new Error(`Unsupported config version: ${config.version}`);
  if (!new Set(["local-git", "github-gh"]).has(config.source.provider)) throw new Error("source.provider must be local-git or github-gh");
  if (config.source.provider === "local-git") {
    if (typeof config.source.checkout !== "string" || !config.source.checkout) throw new Error("source.checkout is required for local-git");
  } else if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.source.repository ?? "")) throw new Error("source.repository must be owner/name for github-gh");
  const providers = new Set(["openai-compatible", "openai", "anthropic", "vertex", "claude-cli", "codex-cli"]);
  if (!providers.has(config.model.provider)) throw new Error("model.provider must be openai-compatible, openai, anthropic, vertex, claude-cli, or codex-cli");
  if (CLI_PROVIDERS.has(config.model.provider) ? config.model.authMode !== 'none' || config.model.apiKeyEnv !== null : config.model.provider !== "openai-compatible" && config.model.authMode === "none") throw new Error("CLI providers use their own login; API providers require a credential");
  const endpoint = endpointUrl(config.model.endpoint, "model.endpoint");
  if (config.model.provider === "vertex" && !/^\/v1(?:beta1)?\/projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\/?$/.test(endpoint.pathname)) throw new Error("model.endpoint must identify a Vertex publisher model collection");
  if (typeof config.model.model !== "string" || !config.model.model) throw new Error("model.model is required");
  if (CLI_PROVIDERS.has(config.model.provider) && (config.model.model.length > 200 || !/^[A-Za-z0-9_.:/-]+$/.test(config.model.model))) throw new Error('CLI model ID must contain only letters, numbers, dot, underscore, colon, slash, or hyphen');
  if (config.model.apiKeyEnv === null ? config.model.authMode !== "none" : !/^[A-Z][A-Z0-9_]{1,127}$/.test(config.model.apiKeyEnv)) throw new Error("model.apiKeyEnv must name an environment variable unless model.authMode is none");
  if (!Number.isSafeInteger(config.model.timeoutMs) || config.model.timeoutMs < 1 || config.model.timeoutMs > 300_000) throw new Error("model.timeoutMs must be between 1 and 300000");
  if (!new Set(["auto", "required", "disabled"]).has(config.model.jsonSchema)) throw new Error("model.jsonSchema must be auto, required, or disabled");
  if (!new Set(["auto", "max_tokens", "max_completion_tokens"]).has(config.model.tokenParameter)) throw new Error("model.tokenParameter must be auto, max_tokens, or max_completion_tokens");
  if (!new Set(["auto", "enabled", "disabled"]).has(config.model.temperatureMode)) throw new Error("model.temperatureMode must be auto, enabled, or disabled");
  if (!new Set(["system", "developer", "user-prefix"]).has(config.model.systemInstructionMode)) throw new Error("model.systemInstructionMode must be system, developer, or user-prefix");
  if (!new Set(["auto", "bearer", "x-api-key", "none"]).has(config.model.authMode)) throw new Error("model.authMode must be auto, bearer, x-api-key, or none");
  if (!CLI_PROVIDERS.has(config.model.provider) && config.model.provider !== "openai-compatible" && !["auto", config.model.provider === "anthropic" ? "x-api-key" : "bearer"].includes(config.model.authMode)) throw new Error("model.authMode is incompatible with the native provider");
  if (!new Set(["auto", "local", "remote"]).has(config.model.sourceEgress)) throw new Error("model.sourceEgress must be auto, local, or remote");
  if (!new Set(["auto", "openai", "openrouter", "disabled"]).has(config.model.reasoningMode)) throw new Error("model.reasoningMode must be auto, openai, openrouter, or disabled");
  if (config.model.sourceEgress === "local" && !LOOPBACK_HOSTS.has(endpoint.hostname)) throw new Error("model.sourceEgress=local requires a loopback model.endpoint");
  if (CLI_PROVIDERS.has(config.model.provider) && (config.model.endpoint !== PROVIDER_ENDPOINTS[config.model.provider] || config.model.sourceEgress !== 'remote')) throw new Error('CLI provider requires its managed endpoint and remote source egress');
  if (!Number.isSafeInteger(config.model.maxOutputTokens) || config.model.maxOutputTokens < 256 || config.model.maxOutputTokens > 131_072) throw new Error("model.maxOutputTokens must be between 256 and 131072");
  if (!Number.isSafeInteger(config.model.retryMaxOutputTokens) || config.model.retryMaxOutputTokens < config.model.maxOutputTokens || config.model.retryMaxOutputTokens > 131_072) throw new Error("model.retryMaxOutputTokens must be between maxOutputTokens and 131072");
  if (config.model.contextWindowTokens !== null && (!Number.isSafeInteger(config.model.contextWindowTokens) || config.model.contextWindowTokens < 512)) throw new Error("model.contextWindowTokens must be null or at least 512");
  if (config.model.maxCompletionTokens !== null && (!Number.isSafeInteger(config.model.maxCompletionTokens) || config.model.maxCompletionTokens < 256)) throw new Error("model.maxCompletionTokens must be null or at least 256");
  if (config.model.reasoningEffort !== null && (typeof config.model.reasoningEffort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(config.model.reasoningEffort))) throw new Error("model.reasoningEffort must be null or a bounded identifier");
  if (["anthropic", "vertex"].includes(config.model.provider) && config.model.reasoningEffort !== null) throw new Error("model.reasoningEffort is not supported by this native provider");
  const reviewEndpoint = endpointUrl(config.model.reviewEndpoint, "model.reviewEndpoint");
  if (config.model.reviewProvider === "vertex" && !/^\/v1(?:beta1)?\/projects\/[^/]+\/locations\/[^/]+\/publishers\/[^/]+\/models\/?$/.test(reviewEndpoint.pathname)) throw new Error("model.reviewEndpoint must identify a Vertex publisher model collection");
  if (!providers.has(config.model.reviewProvider)) throw new Error("model.reviewProvider must be openai-compatible, openai, anthropic, vertex, claude-cli, or codex-cli");
  if (CLI_PROVIDERS.has(config.model.reviewProvider) ? config.model.reviewAuthMode !== 'none' || config.model.reviewApiKeyEnv !== null : config.model.reviewProvider !== "openai-compatible" && config.model.reviewAuthMode === "none") throw new Error("CLI reviewer uses its own login; API reviewers require a credential");
  if (typeof config.model.reviewModel !== "string" || !config.model.reviewModel) throw new Error("model.reviewModel must be a model name");
  if (CLI_PROVIDERS.has(config.model.reviewProvider) && (config.model.reviewModel.length > 200 || !/^[A-Za-z0-9_.:/-]+$/.test(config.model.reviewModel))) throw new Error('CLI reviewer model ID contains unsupported characters');
  if (config.model.reviewApiKeyEnv !== null && !/^[A-Z][A-Z0-9_]{1,127}$/.test(config.model.reviewApiKeyEnv)) throw new Error("model.reviewApiKeyEnv must be null or name an environment variable");
  if (!new Set(["auto", "bearer", "x-api-key", "none"]).has(config.model.reviewAuthMode)) throw new Error("model.reviewAuthMode must be auto, bearer, x-api-key, or none");
  if (!CLI_PROVIDERS.has(config.model.reviewProvider) && config.model.reviewProvider !== "openai-compatible" && !["auto", config.model.reviewProvider === "anthropic" ? "x-api-key" : "bearer"].includes(config.model.reviewAuthMode)) throw new Error("model.reviewAuthMode is incompatible with the native provider");
  if (config.model.reviewAuthMode !== "none" && config.model.reviewApiKeyEnv === null) throw new Error("model.reviewApiKeyEnv is required unless model.reviewAuthMode is none");
  if (!Number.isSafeInteger(config.model.reviewTimeoutMs) || config.model.reviewTimeoutMs < 1 || config.model.reviewTimeoutMs > 300_000) throw new Error("model.reviewTimeoutMs must be between 1 and 300000");
  if (!new Set(["auto", "required", "disabled"]).has(config.model.reviewJsonSchema)) throw new Error("model.reviewJsonSchema must be auto, required, or disabled");
  if (!Number.isSafeInteger(config.model.reviewMaxOutputTokens) || config.model.reviewMaxOutputTokens < 256 || config.model.reviewMaxOutputTokens > 131_072) throw new Error("model.reviewMaxOutputTokens must be between 256 and 131072");
  if (!Number.isSafeInteger(config.model.reviewRetryMaxOutputTokens) || config.model.reviewRetryMaxOutputTokens < config.model.reviewMaxOutputTokens || config.model.reviewRetryMaxOutputTokens > 131_072) throw new Error("model.reviewRetryMaxOutputTokens must be between reviewMaxOutputTokens and 131072");
  if (config.model.reviewContextWindowTokens !== null && (!Number.isSafeInteger(config.model.reviewContextWindowTokens) || config.model.reviewContextWindowTokens < 512)) throw new Error("model.reviewContextWindowTokens must be null or at least 512");
  if (config.model.reviewMaxCompletionTokens !== null && (!Number.isSafeInteger(config.model.reviewMaxCompletionTokens) || config.model.reviewMaxCompletionTokens < 256)) throw new Error("model.reviewMaxCompletionTokens must be null or at least 256");
  if (!new Set(["auto", "max_tokens", "max_completion_tokens"]).has(config.model.reviewTokenParameter)) throw new Error("model.reviewTokenParameter must be auto, max_tokens, or max_completion_tokens");
  if (!new Set(["auto", "enabled", "disabled"]).has(config.model.reviewTemperatureMode)) throw new Error("model.reviewTemperatureMode must be auto, enabled, or disabled");
  if (!new Set(["system", "developer", "user-prefix"]).has(config.model.reviewSystemInstructionMode)) throw new Error("model.reviewSystemInstructionMode must be system, developer, or user-prefix");
  if (!new Set(["auto", "openai", "openrouter", "disabled"]).has(config.model.reviewReasoningMode)) throw new Error("model.reviewReasoningMode must be auto, openai, openrouter, or disabled");
  if (!new Set(["auto", "local", "remote"]).has(config.model.reviewSourceEgress)) throw new Error("model.reviewSourceEgress must be auto, local, or remote");
  if (config.model.reviewSourceEgress === "local" && !LOOPBACK_HOSTS.has(reviewEndpoint.hostname)) throw new Error("model.reviewSourceEgress=local requires a loopback model.reviewEndpoint");
  if (CLI_PROVIDERS.has(config.model.reviewProvider) && (config.model.reviewEndpoint !== PROVIDER_ENDPOINTS[config.model.reviewProvider] || config.model.reviewSourceEgress !== 'remote')) throw new Error('CLI reviewer requires its managed endpoint and remote source egress');
  if (config.model.reviewReasoningEffort !== null && (typeof config.model.reviewReasoningEffort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(config.model.reviewReasoningEffort))) throw new Error("model.reviewReasoningEffort must be null or a bounded identifier");
  if (["anthropic", "vertex"].includes(config.model.reviewProvider) && config.model.reviewReasoningEffort !== null) throw new Error("model.reviewReasoningEffort is not supported by this native provider");
  if ("apiKey" in config.model) throw new Error("Configure model.apiKeyEnv, never a secret value");
  return config;
}

export async function loadConfig({ configFile, env = process.env, overrides = {} } = {}) {
  let fileConfig = {};
  if (configFile) {
    const absolute = path.resolve(configFile);
    let body;
    try { body = await readFile(absolute, "utf8"); }
    catch (error) { throw new Error(`Unable to read config file ${absolute}: ${error.message}`, { cause: error }); }
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("Configuration file exceeds 1 MiB");
    try { fileConfig = JSON.parse(body); }
    catch (error) { throw new Error(`Invalid JSON config file ${absolute}`, { cause: error }); }
    rejectUnknown(fileConfig, SHAPE);
  }
  rejectUnknown(overrides, SHAPE, "overrides");
  const defaults = { ...DEFAULT_CONFIG, source: { ...DEFAULT_CONFIG.source }, model: { ...DEFAULT_CONFIG.model } };
  let config = merge(merge(merge(defaults, fileConfig), envOverlay(env)), overrides);
  const explicitModel = { ...fileConfig.model, ...envOverlay(env).model, ...overrides.model };
  if (CLI_PROVIDERS.has(config.model.provider)) {
    if (!Object.hasOwn(explicitModel, 'model')) config.model.model = 'default';
    if (!Object.hasOwn(explicitModel, 'timeoutMs')) config.model.timeoutMs = 120_000;
    if (!Object.hasOwn(explicitModel, 'authMode')) config.model.authMode = 'none';
    if (!Object.hasOwn(explicitModel, 'apiKeyEnv')) config.model.apiKeyEnv = null;
    if (!Object.hasOwn(explicitModel, 'sourceEgress')) config.model.sourceEgress = 'remote';
  }
  if (config.model.provider !== "openai-compatible" && !Object.hasOwn(explicitModel, "endpoint") && PROVIDER_ENDPOINTS[config.model.provider]) config.model.endpoint = PROVIDER_ENDPOINTS[config.model.provider];
  if (config.model.provider === "vertex" && !Object.hasOwn(explicitModel, "endpoint")) throw new Error("model.endpoint is required for vertex and must identify a Vertex publisher model collection");
  if (config.model.provider !== "openai-compatible" && !Object.hasOwn(explicitModel, "apiKeyEnv")) config.model.apiKeyEnv = PROVIDER_KEY_ENVS[config.model.provider] ?? null;
  if (CLI_PROVIDERS.has(config.model.reviewProvider)) {
    if (!Object.hasOwn(explicitModel, 'reviewEndpoint')) config.model.reviewEndpoint = PROVIDER_ENDPOINTS[config.model.reviewProvider];
    if (!Object.hasOwn(explicitModel, 'reviewAuthMode')) config.model.reviewAuthMode = 'none';
    if (!Object.hasOwn(explicitModel, 'reviewApiKeyEnv')) config.model.reviewApiKeyEnv = null;
    if (!Object.hasOwn(explicitModel, 'reviewSourceEgress')) config.model.reviewSourceEgress = 'remote';
    if (!Object.hasOwn(explicitModel, 'reviewTimeoutMs')) config.model.reviewTimeoutMs = 120_000;
  }
  if (config.source.provider === "local-git") config.source.checkout = path.resolve(config.source.checkout);
  config = resolveReviewer(config);
  validate(config);
  return Object.freeze({ ...config, source: Object.freeze(config.source), model: Object.freeze(config.model) });
}

/** Safe for APIs, logs, diagnostics, and bug reports; never resolves or exposes a key. */
export function publicConfig(config, { env = process.env } = {}) {
  validate(config);
  return {
    version: config.version,
    source: { ...config.source },
    model: {
      provider: config.model.provider, endpoint: config.model.endpoint, model: config.model.model,
      timeoutMs: config.model.timeoutMs, jsonSchema: config.model.jsonSchema,
      maxOutputTokens: config.model.maxOutputTokens, retryMaxOutputTokens: config.model.retryMaxOutputTokens,
      contextWindowTokens: config.model.contextWindowTokens, maxCompletionTokens: config.model.maxCompletionTokens,
      reasoningEffort: config.model.reasoningEffort, tokenParameter: config.model.tokenParameter,
      reasoningMode: config.model.reasoningMode,
      temperatureMode: config.model.temperatureMode, systemInstructionMode: config.model.systemInstructionMode, authMode: config.model.authMode,
      sourceEgress: config.model.sourceEgress, reviewProvider: config.model.reviewProvider, reviewEndpoint: config.model.reviewEndpoint,
      reviewModel: config.model.reviewModel, reviewTimeoutMs: config.model.reviewTimeoutMs,
      reviewJsonSchema: config.model.reviewJsonSchema, reviewMaxOutputTokens: config.model.reviewMaxOutputTokens,
      reviewRetryMaxOutputTokens: config.model.reviewRetryMaxOutputTokens, reviewContextWindowTokens: config.model.reviewContextWindowTokens,
      reviewMaxCompletionTokens: config.model.reviewMaxCompletionTokens, reviewTokenParameter: config.model.reviewTokenParameter,
      reviewTemperatureMode: config.model.reviewTemperatureMode, reviewSystemInstructionMode: config.model.reviewSystemInstructionMode,
      reviewAuthMode: config.model.reviewAuthMode, reviewReasoningMode: config.model.reviewReasoningMode,
      reviewReasoningEffort: config.model.reviewReasoningEffort, reviewSourceEgress: config.model.reviewSourceEgress,
      reviewCredential: { envVar: config.model.reviewAuthMode === "none" ? null : config.model.reviewApiKeyEnv, required: !CLI_PROVIDERS.has(config.model.reviewProvider) && (config.model.reviewProvider !== "openai-compatible" || new Set(["bearer", "x-api-key"]).has(config.model.reviewAuthMode)), configured: Boolean(config.model.reviewAuthMode !== "none" && config.model.reviewApiKeyEnv && env[config.model.reviewApiKeyEnv]) },
      credential: { envVar: config.model.authMode === "none" ? null : config.model.apiKeyEnv, required: !CLI_PROVIDERS.has(config.model.provider) && (config.model.provider !== "openai-compatible" || new Set(["bearer", "x-api-key"]).has(config.model.authMode)), configured: Boolean(config.model.authMode !== "none" && env[config.model.apiKeyEnv]) },
    },
  };
}

export const configInternals = { DEFAULT_CONFIG, envOverlay, validate };

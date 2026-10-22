// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { PROVIDER_API_VERSION } from "../contracts.mjs";

const JSON_SCHEMA_MODES = new Set(["auto", "required", "disabled"]);
const TOKEN_PARAMETERS = new Set(["auto", "max_tokens", "max_completion_tokens"]);
const TEMPERATURE_MODES = new Set(["auto", "enabled", "disabled"]);
const SYSTEM_INSTRUCTION_MODES = new Set(["system", "developer", "user-prefix"]);
const AUTH_MODES = new Set(["auto", "bearer", "x-api-key", "none"]);
const REASONING_REQUEST_MODES = new Set(["auto", "openai", "openrouter", "disabled"]);
const PROBE_TIMEOUT_MS = 3_000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const NEGOTIATION_TTL_MS = 5 * 60_000;

function normalizedEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new TypeError("Model endpoint must be an absolute URL"); }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError("Model endpoint must be an HTTP(S) base URL without credentials, query, or fragment");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new TypeError("Remote model endpoints must use HTTPS");
  return url.href.replace(/\/$/, "");
}
function timedSignal(signal, timeoutMs) { const timeout = AbortSignal.timeout(timeoutMs); return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, timeout }; }
function positiveInteger(value) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : null; }
function tokenCount(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : null; }
function boundedField(value) { if (!["string", "number"].includes(typeof value)) return null; const text = String(value).slice(0, 128); return /^[\w.:[\]/ -]+$/u.test(text) ? text : null; }
function boundedScalar(value, fallback = null, maxLength = 256) {
  if (!["string", "number", "boolean"].includes(typeof value)) return fallback;
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return text ? text.slice(0, maxLength) : fallback;
}
function timeoutError() { const error = new Error("Model provider request timed out"); error.name = "ProviderTimeoutError"; error.code = "model_provider_timeout"; error.retryable = true; return error; }
function tooLargeError() { const error = new Error("Model provider response exceeded the configured size limit"); error.code = "model_provider_response_too_large"; error.retryable = false; return error; }

class ProviderHttpError extends Error {
  constructor(operation, response, body) {
    super(`${operation} failed with HTTP ${response.status}`);
    this.name = "ProviderHttpError"; this.code = "model_provider_http_error"; this.status = response.status;
    this.retryable = response.status >= 500 || [408, 409, 425, 429].includes(response.status);
    this.providerCode = boundedField(body?.error?.code ?? body?.code);
    this.providerParam = boundedField(body?.error?.param ?? body?.param);
    this.providerType = boundedField(body?.error?.type ?? body?.type);
    // Some compatible providers only identify an unsupported field in their
    // prose message. Keep a bounded copy for negotiation, but make it
    // non-enumerable so diagnostics and JSON logs cannot disclose provider text.
    Object.defineProperty(this, "providerMessage", { value: boundedScalar(body?.error?.message ?? body?.message) });
    if (response.status === 403 && /only available (?:on|to) agentic harnesses/i.test(this.providerMessage || "")) this.code = "model_provider_access_restricted";
    if (response.status === 403 && /age confirmation/i.test(this.providerMessage || "")) this.code = "model_provider_age_confirmation_required";
  }
}
class ProviderCredentialError extends Error {
  constructor(apiKeyEnv) {
    super(`Model credential environment variable ${apiKeyEnv} is not configured`);
    this.name = "ProviderCredentialError"; this.code = "model_provider_credential_missing"; this.retryable = false;
  }
}
async function boundedText(response, maxBytes) {
  if (!response.body) return "";
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLargeError();
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let bytes = 0; let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel().catch(() => {}); throw tooLargeError(); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
async function jsonResponse(response, operation, maxBytes) {
  const text = await boundedText(response, maxBytes); let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch (cause) { const error = new Error(`${operation} returned invalid JSON`, { cause }); error.code = "model_provider_invalid_json"; error.retryable = false; throw error; }
  if (!response.ok) throw new ProviderHttpError(operation, response, body);
  return body;
}
function normalizedUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = tokenCount(usage.prompt_tokens ?? usage.input_tokens), outputTokens = tokenCount(usage.completion_tokens ?? usage.output_tokens);
  const reasoningTokens = tokenCount(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens);
  const cachedInputTokens = tokenCount(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens);
  return { inputTokens, outputTokens, reasoningTokens, cachedInputTokens, totalTokens: tokenCount(usage.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null) };
}
function mappedMessages(messages, mode) {
  if (mode === "system") return messages;
  if (mode === "developer") return messages.map((message) => message?.role === "system" ? { ...message, role: "developer" } : message);
  const system = messages.filter((message) => message?.role === "system").map((message) => String(message.content || "")).join("\n\n");
  const remaining = messages.filter((message) => message?.role !== "system"); if (!system) return remaining;
  const prefix = `Instructions:\n${system}\n\n`, firstUser = remaining.findIndex((message) => message?.role === "user");
  return firstUser >= 0 ? remaining.map((message, index) => index === firstUser ? { ...message, content: `${prefix}${String(message.content || "")}` } : message) : [{ role: "user", content: prefix.trimEnd() }, ...remaining];
}
function isNegotiable(error, field) {
  if (!(error instanceof ProviderHttpError) || ![400, 422].includes(error.status)) return false;
  const param = error.providerParam?.toLowerCase(), code = error.providerCode?.toLowerCase();
  if (field === "schema" && (param === "response_format" || ["unsupported_response_format", "invalid_response_format", "json_schema_unsupported"].includes(code))) return true;
  if (field !== "schema" && (param === field || code === `unsupported_${field}` || code === `invalid_${field}`)) return true;
  const message = error.providerMessage?.toLowerCase();
  if (!message || !/(?:unsupported|not supported|unrecognized|unknown (?:argument|parameter|field)|invalid (?:request )?(?:argument|parameter|field))/u.test(message)) return false;
  const attempted = field === "schema" ? ["response_format", "json_schema"] : [field];
  return attempted.some((name) => new RegExp(`(?:^|[^a-z0-9_])${name}(?:$|[^a-z0-9_])`, "u").test(message));
}
function requiresReasoning(error) {
  return error instanceof ProviderHttpError && [400, 422].includes(error.status)
    && /reasoning is mandatory.*cannot be disabled/i.test(error.providerMessage || "");
}

export class OpenAICompatibleModelProvider {
  apiVersion = PROVIDER_API_VERSION; id = "openai-compatible"; kind = "openai-compatible";
  constructor({ endpoint, model, apiKeyEnv = "OPENAI_API_KEY", authMode = "auto", timeoutMs = 60_000, jsonSchema = "auto", tokenParameter = "auto", temperatureMode = "auto", systemInstructionMode = "system", reasoningEffort = null, reasoningRequestMode = "auto", responseMaxBytes = RESPONSE_MAX_BYTES, fetch = globalThis.fetch, env = process.env } = {}) {
    this.endpoint = normalizedEndpoint(endpoint);
    if (typeof model !== "string" || !model.trim()) throw new TypeError("A model name is required");
    if (apiKeyEnv === null ? authMode !== "none" : !/^[A-Z][A-Z0-9_]{1,127}$/.test(apiKeyEnv)) throw new TypeError("apiKeyEnv must name an environment variable unless authMode is none");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError("timeoutMs must be between 1 and 300000");
    if (!JSON_SCHEMA_MODES.has(jsonSchema)) throw new TypeError("jsonSchema must be auto, required, or disabled");
    if (!TOKEN_PARAMETERS.has(tokenParameter)) throw new TypeError("tokenParameter must be auto, max_tokens, or max_completion_tokens");
    if (!TEMPERATURE_MODES.has(temperatureMode)) throw new TypeError("temperatureMode must be auto, enabled, or disabled");
    if (!SYSTEM_INSTRUCTION_MODES.has(systemInstructionMode)) throw new TypeError("systemInstructionMode must be system, developer, or user-prefix");
    if (!AUTH_MODES.has(authMode)) throw new TypeError("authMode must be auto, bearer, x-api-key, or none");
    if (!REASONING_REQUEST_MODES.has(reasoningRequestMode)) throw new TypeError("reasoningRequestMode must be auto, openai, openrouter, or disabled");
    if (reasoningEffort !== null && (typeof reasoningEffort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(reasoningEffort))) throw new TypeError("reasoningEffort must be null or a bounded identifier");
    if (!Number.isSafeInteger(responseMaxBytes) || responseMaxBytes < 1 || responseMaxBytes > 16 * 1024 * 1024) throw new TypeError("responseMaxBytes must be between 1 and 16777216");
    if (typeof fetch !== "function") throw new TypeError("A fetch implementation is required");
    Object.assign(this, { model, apiKeyEnv, authMode, timeoutMs, jsonSchema, tokenParameter, temperatureMode, systemInstructionMode, reasoningEffort, reasoningRequestMode, responseMaxBytes });
    Object.defineProperties(this, { fetch: { value: fetch }, env: { value: env } }); this.capabilitiesExpiresAt = 0; this.negotiatedExpiresAt = 0;
  }
  #headers() {
    const headers = { "content-type": "application/json", accept: "application/json" }, key = this.apiKeyEnv === null ? undefined : this.env[this.apiKeyEnv];
    const mode = this.authMode === "auto" ? (key ? "bearer" : "none") : this.authMode;
    if (mode !== "none" && !key) throw new ProviderCredentialError(this.apiKeyEnv);
    if (mode === "bearer") headers.authorization = `Bearer ${key}`; if (mode === "x-api-key") headers["x-api-key"] = key; return headers;
  }
  async probeCapabilities({ signal, refresh = false, timeoutMs = Math.min(this.timeoutMs, PROBE_TIMEOUT_MS) } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError("Capability timeoutMs must be between 1 and 30000");
    if (this.capabilities && !refresh && Date.now() < this.capabilitiesExpiresAt) return this.capabilities;
    const request = timedSignal(signal, timeoutMs);
    const response = await this.fetch(`${this.endpoint}/models`, { method: "GET", headers: this.#headers(), signal: request.signal, redirect: "error" });
    const body = await jsonResponse(response, "Model capability probe", this.responseMaxBytes);
    const record = Array.isArray(body?.data) ? body.data.find((entry) => entry?.id === this.model) : undefined;
    const supported = Array.isArray(record?.supported_parameters) ? record.supported_parameters.filter((value) => typeof value === "string").slice(0, 128) : [];
    this.capabilities = Object.freeze({ model: this.model, modelAdvertised: Boolean(record), jsonSchema: this.jsonSchema !== "disabled" && (body?.capabilities?.json_schema === true || supported.includes("response_format")), cancellation: true, contextWindowTokens: positiveInteger(record?.top_provider?.context_length ?? record?.context_length), maxCompletionTokens: positiveInteger(record?.top_provider?.max_completion_tokens ?? record?.max_completion_tokens), supportedParameters: Object.freeze([...supported]) });
    this.capabilitiesExpiresAt = Date.now() + NEGOTIATION_TTL_MS; return this.capabilities;
  }
  async capabilitiesOrUnknown({ signal, timeoutMs = Math.min(this.timeoutMs, PROBE_TIMEOUT_MS) } = {}) {
    try { return await this.probeCapabilities({ signal, timeoutMs }); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (error?.code === "model_provider_credential_missing") throw error;
      this.capabilities = Object.freeze({ model: this.model, modelAdvertised: false, jsonSchema: null, cancellation: true, contextWindowTokens: null, maxCompletionTokens: null, supportedParameters: Object.freeze([]), probeError: error.name || (typeof error.code === "string" ? error.code : null) || "capability_probe_failed" });
      this.capabilitiesExpiresAt = Date.now() + 30_000; return this.capabilities;
    }
  }
  #token(capabilities) { return this.tokenParameter !== "auto" ? this.tokenParameter : capabilities.supportedParameters.includes("max_completion_tokens") ? "max_completion_tokens" : "max_tokens"; }
  #temperature(capabilities) { return this.temperatureMode === "enabled" || (this.temperatureMode === "auto" && (capabilities.supportedParameters.length === 0 || capabilities.supportedParameters.includes("temperature"))); }
  #resolvedReasoningMode(capabilities) {
    if (!this.reasoningEffort || this.reasoningRequestMode === "disabled") return "disabled";
    let mode = this.reasoningRequestMode;
    if (mode === "auto") mode = capabilities.supportedParameters.includes("reasoning") && !capabilities.supportedParameters.includes("reasoning_effort") ? "openrouter" : "openai";
    return mode;
  }
  #reasoning(capabilities) {
    const mode = this.#resolvedReasoningMode(capabilities);
    if (mode === "disabled") return {};
    return mode === "openrouter" ? { reasoning: { effort: this.reasoningEffort, exclude: true } } : { reasoning_effort: this.reasoningEffort };
  }
  async #request({ messages, schema, schemaName, temperature, maxTokens, signal, requestExtensions, capabilities, structuredOutputMode, tokenParameter, reasoningFallback }) {
    const response_format = structuredOutputMode === "json_schema" ? { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } } : { type: "json_object" };
    const reasoning = reasoningFallback === "low"
      ? this.#resolvedReasoningMode(capabilities) === "openai" ? { reasoning_effort: "low" } : { reasoning: { effort: "low", exclude: true } }
      : reasoningFallback === "provider_default" ? {} : this.#reasoning(capabilities);
    const body = { model: this.model, messages: mappedMessages(messages, this.systemInstructionMode), ...(this.#temperature(capabilities) ? { temperature } : {}), ...(maxTokens ? { [tokenParameter]: maxTokens } : {}), ...reasoning, ...requestExtensions, ...(structuredOutputMode === "none" ? {} : { response_format }) };
    const response = await this.fetch(`${this.endpoint}/chat/completions`, { method: "POST", headers: this.#headers(), signal, redirect: "error", body: JSON.stringify(body) });
    return jsonResponse(response, "Model completion", this.responseMaxBytes);
  }
  async completeJson({ messages, schema, schemaName = "quiz_response", temperature = 0, maxTokens, timeoutMs = this.timeoutMs, capabilityTimeoutMs = Math.min(timeoutMs, PROBE_TIMEOUT_MS), signal, requestExtensions = {} } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) throw new TypeError("messages must be a non-empty array");
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new TypeError("A JSON schema is required");
    if (typeof schemaName !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(schemaName)) throw new TypeError("schemaName must be a bounded identifier");
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new TypeError("temperature must be between 0 and 2");
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) throw new TypeError("maxTokens must be a positive integer");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError("timeoutMs must be between 1 and 300000");
    if (!Number.isSafeInteger(capabilityTimeoutMs) || capabilityTimeoutMs < 1 || capabilityTimeoutMs > 30_000) throw new TypeError("capabilityTimeoutMs must be between 1 and 30000");
    if (!requestExtensions || typeof requestExtensions !== "object" || Array.isArray(requestExtensions)) throw new TypeError("requestExtensions must be an object");
    const reserved = ["model", "messages", "temperature", "max_tokens", "max_completion_tokens", "reasoning", "reasoning_effort", "response_format"];
    if (reserved.some((key) => Object.hasOwn(requestExtensions, key))) throw new TypeError("requestExtensions cannot override core request fields");
    const deadline = timedSignal(signal, timeoutMs);
    try {
      const capabilities = await this.capabilitiesOrUnknown({ signal: deadline.signal, timeoutMs: Math.min(timeoutMs, capabilityTimeoutMs) });
      const cached = this.negotiated && Date.now() < this.negotiatedExpiresAt ? this.negotiated : null;
      let structuredOutputMode = cached?.structuredOutputMode ?? (this.jsonSchema === "disabled" ? "json_object" : this.jsonSchema === "auto" && new URL(this.endpoint).hostname === "openrouter.ai" && capabilities.modelAdvertised && capabilities.jsonSchema === false ? "none" : "json_schema");
      let tokenParameter = cached?.tokenParameter ?? this.#token(capabilities), reasoningFallback = cached?.reasoningFallback ?? "none", body; const tried = new Set();
      while (true) {
        const key = `${structuredOutputMode}:${tokenParameter}:${reasoningFallback}`; if (tried.has(key)) throw new Error("Model request negotiation exhausted available alternatives"); tried.add(key);
        try { body = await this.#request({ messages, schema, schemaName, temperature, maxTokens, signal: deadline.signal, requestExtensions, capabilities, structuredOutputMode, tokenParameter, reasoningFallback }); break; }
        catch (error) {
          if (this.jsonSchema === "auto" && structuredOutputMode === "json_schema" && isNegotiable(error, "schema")) { structuredOutputMode = "json_object"; continue; }
          if (this.jsonSchema === "auto" && structuredOutputMode === "json_object" && isNegotiable(error, "schema")) { structuredOutputMode = "none"; continue; }
          if (this.tokenParameter === "auto" && maxTokens && isNegotiable(error, tokenParameter)) { tokenParameter = tokenParameter === "max_tokens" ? "max_completion_tokens" : "max_tokens"; continue; }
          if (reasoningFallback === "none" && this.reasoningEffort === "none" && requiresReasoning(error)) { reasoningFallback = "low"; continue; }
          if (reasoningFallback === "low" && isNegotiable(error, "reasoning")) { reasoningFallback = "provider_default"; continue; }
          throw error;
        }
      }
      this.negotiated = Object.freeze({ structuredOutputMode, tokenParameter, reasoningFallback }); this.negotiatedExpiresAt = Date.now() + NEGOTIATION_TTL_MS;
      const choice = body?.choices?.[0], usage = normalizedUsage(body?.usage);
      const configuredModel = boundedScalar(this.model, "unknown-model");
      const model = boundedScalar(body?.model, configuredModel), finishReason = boundedScalar(choice?.finish_reason, "unknown");
      if (["length", "max_tokens", "max_output_tokens"].includes(finishReason)) { const error = new Error("Model completion reached its output token limit"); error.code = "model_output_truncated"; error.usage = usage; error.diagnostics = { finish_reason: finishReason, completion_tokens: usage?.outputTokens ?? null, content_chars: typeof choice?.message?.content === "string" ? choice.message.content.length : null }; throw error; }
      const content = choice?.message?.content;
      if (typeof content !== "string") { const error = new Error("Model completion did not contain message content"); error.code = "model_provider_invalid_response"; error.usage = usage; throw error; }
      try { return { value: JSON.parse(content), usage, model, finishReason, outputCharacters: content.length, structuredOutputMode, tokenParameter, reasoningRequestMode: reasoningFallback === "none" ? this.#resolvedReasoningMode(capabilities) : reasoningFallback === "low" ? `${this.#resolvedReasoningMode(capabilities)}_low_fallback` : "provider_default", temperatureIncluded: this.#temperature(capabilities) }; }
      catch (cause) { const error = new Error("Model completion content was not valid JSON", { cause }); error.code = "model_output_invalid_json"; error.usage = usage; error.diagnostics = { finish_reason: finishReason || "unknown", completion_tokens: usage?.outputTokens ?? null, content_chars: content.length }; throw error; }
    } catch (error) { if (signal?.aborted) throw error; if (deadline.timeout.aborted) throw timeoutError(); throw error; }
  }
}

export const openAICompatibleInternals = { normalizedEndpoint, normalizedUsage, mappedMessages, ProviderHttpError, ProviderCredentialError, boundedText, boundedScalar, isNegotiable };

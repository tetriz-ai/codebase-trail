// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { PROVIDER_API_VERSION } from '../contracts.mjs';
import { openAICompatibleInternals } from './openai-compatible.mjs';

const { normalizedEndpoint, boundedText, boundedScalar } = openAICompatibleInternals;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const token = (value) => value !== null && value !== undefined && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const usageOf = (input, output, cached = null) => ({ inputTokens: token(input), outputTokens: token(output), reasoningTokens: null, cachedInputTokens: token(cached), totalTokens: token(input) !== null && token(output) !== null ? Number(input) + Number(output) : null });
function structuredSchema(value) {
  if (Array.isArray(value)) return value.map(structuredSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['minLength', 'maxLength'].includes(key)).map(([key, item]) => [key, structuredSchema(item)]));
}
function failure(code, message, usage = null) { const error = new Error(message); error.code = code; error.usage = usage; return error; }

export class NativeModelProvider {
  apiVersion = PROVIDER_API_VERSION;
  constructor({ provider, endpoint, model, apiKeyEnv, authMode = 'auto', timeoutMs = 60_000, jsonSchema = 'auto', temperatureMode = 'auto', reasoningEffort = null, fetch = globalThis.fetch, env = process.env } = {}) {
    if (!['openai', 'anthropic', 'vertex'].includes(provider)) throw new TypeError('Unknown native model provider');
    this.endpoint = normalizedEndpoint(endpoint);
    if (typeof model !== 'string' || !model.trim()) throw new TypeError('A model name is required');
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(apiKeyEnv ?? '')) throw new TypeError('apiKeyEnv must name an environment variable');
    if (!['auto', provider === 'anthropic' ? 'x-api-key' : 'bearer'].includes(authMode)) throw new TypeError('authMode is incompatible with the native provider');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('timeoutMs must be between 1 and 300000');
    if (!['auto', 'required', 'disabled'].includes(jsonSchema)) throw new TypeError('Invalid jsonSchema mode');
    if (typeof fetch !== 'function') throw new TypeError('A fetch implementation is required');
    Object.assign(this, { id: provider, kind: provider, model, apiKeyEnv, authMode, timeoutMs, jsonSchema, temperatureMode, reasoningEffort });
    Object.defineProperties(this, { fetch: { value: fetch }, env: { value: env } });
  }
  async probeCapabilities() { return { model: this.model, modelAdvertised: false, jsonSchema: this.jsonSchema !== 'disabled', cancellation: true, contextWindowTokens: null, maxCompletionTokens: null, supportedParameters: [] }; }
  async capabilitiesOrUnknown(options) { return this.probeCapabilities(options); }
  async completeJson({ messages, schema, schemaName = 'quiz_response', temperature = 0, maxTokens, timeoutMs = this.timeoutMs, signal, requestExtensions = {} } = {}) {
    if (!Array.isArray(messages) || !messages.length || !messages.every((message) => ['system', 'user', 'assistant'].includes(message?.role) && typeof message.content === 'string')) throw new TypeError('messages must contain text roles');
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new TypeError('A JSON schema is required');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(schemaName)) throw new TypeError('schemaName must be a bounded identifier');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new TypeError('maxTokens must be a positive integer');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('Invalid timeoutMs');
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new TypeError('Invalid temperature');
    if (!requestExtensions || typeof requestExtensions !== 'object' || Object.keys(requestExtensions).length) throw new TypeError('Native providers do not accept requestExtensions');
    const key = this.env[this.apiKeyEnv];
    if (!key) { const error = failure('model_provider_credential_missing', `Model credential environment variable ${this.apiKeyEnv} is not configured`); error.retryable = false; throw error; }
    const timed = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timed]) : timed;
    let url, headers = { 'content-type': 'application/json', accept: 'application/json' }, body;
    if (this.id === 'openai') {
      url = `${this.endpoint}/responses`; headers.authorization = `Bearer ${key}`;
      body = { model: this.model, input: messages, max_output_tokens: maxTokens,
        ...(this.reasoningEffort ? { reasoning: { effort: this.reasoningEffort } } : {}),
        ...(this.temperatureMode === 'enabled' || (this.temperatureMode === 'auto' && !this.reasoningEffort) ? { temperature } : {}),
        text: { format: this.jsonSchema === 'disabled' ? { type: 'json_object' } : { type: 'json_schema', name: schemaName, strict: true, schema: structuredSchema(schema) } } };
    } else if (this.id === 'anthropic') {
      url = `${this.endpoint}/messages`; headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
      body = { model: this.model, max_tokens: maxTokens, system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'),
        messages: messages.filter((m) => m.role !== 'system').map((m) => this.jsonSchema === 'disabled' && m.role === 'user' ? { ...m, content: `${m.content}\n\nReturn exactly one JSON object.` } : m),
        ...(this.jsonSchema === 'disabled' ? {} : { output_config: { format: { type: 'json_schema', schema: structuredSchema(schema) } } }),
        ...(this.temperatureMode === 'enabled' ? { temperature } : {}) };
    } else {
      url = `${this.endpoint}/${encodeURIComponent(this.model)}:generateContent`; headers.authorization = `Bearer ${key}`;
      body = { systemInstruction: { parts: messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content })) },
        contents: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json', ...(this.jsonSchema === 'disabled' ? {} : { responseJsonSchema: structuredSchema(schema) }), ...(this.temperatureMode !== 'disabled' ? { temperature } : {}) } };
    }
    try {
      requestSignal.throwIfAborted();
      const response = await this.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); const error = failure('model_provider_http_error', `Model completion failed with HTTP ${response.status}`); error.status = response.status; error.retryable = response.status >= 500 || [408, 409, 425, 429].includes(response.status); throw error; }
      const raw = await boundedText(response, MAX_RESPONSE_BYTES);
      let data;
      try { data = JSON.parse(raw); } catch { throw failure('model_provider_invalid_json', 'Model provider returned invalid JSON'); }
      let value, content, finishReason, usage;
      if (this.id === 'openai') {
        usage = usageOf(data.usage?.input_tokens, data.usage?.output_tokens, data.usage?.input_tokens_details?.cached_tokens);
        usage.reasoningTokens = token(data.usage?.output_tokens_details?.reasoning_tokens);
        finishReason = data.status ?? 'unknown';
        if (finishReason === 'incomplete') throw failure('model_output_truncated', 'Model completion was incomplete', usage);
        content = data.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text;
      } else if (this.id === 'anthropic') {
        usage = usageOf(data.usage?.input_tokens, data.usage?.output_tokens, data.usage?.cache_read_input_tokens);
        finishReason = data.stop_reason ?? 'unknown';
        if (finishReason === 'max_tokens') throw failure('model_output_truncated', 'Model completion reached its output token limit', usage);
        content = data.content?.find((item) => item.type === 'text')?.text;
      } else {
        usage = usageOf(data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount, data.usageMetadata?.cachedContentTokenCount);
        finishReason = data.candidates?.[0]?.finishReason ?? 'unknown';
        if (finishReason === 'MAX_TOKENS') throw failure('model_output_truncated', 'Model completion reached its output token limit', usage);
        content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
      }
      if (value === undefined) {
        if (typeof content !== 'string') throw failure('model_provider_invalid_response', 'Model completion did not contain JSON content', usage);
        try { value = JSON.parse(content); } catch { throw failure('model_output_invalid_json', 'Model completion content was not valid JSON', usage); }
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('model_provider_invalid_response', 'Model completion was not a JSON object', usage);
      return { value, usage, model: boundedScalar(data.model ?? data.modelVersion, this.model), finishReason, outputCharacters: content?.length ?? JSON.stringify(value).length, structuredOutputMode: this.jsonSchema === 'disabled' ? 'json_object' : 'json_schema', tokenParameter: this.id === 'openai' ? 'max_output_tokens' : this.id === 'anthropic' ? 'max_tokens' : 'maxOutputTokens', reasoningRequestMode: this.reasoningEffort ? this.id : 'disabled', temperatureIncluded: Object.hasOwn(body, 'temperature') || Object.hasOwn(body.generationConfig ?? {}, 'temperature') };
    } catch (error) { if (signal?.aborted) throw error; if (timed.aborted) throw failure('model_provider_timeout', 'Model provider request timed out'); throw error; }
  }
}

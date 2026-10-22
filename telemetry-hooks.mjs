// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
const EVENT_TYPES = new Set(['generation.completed', 'generation.rejected', 'evaluation.completed']);
const SAFE_FIELDS = new Set(['event_type', 'occurred_at', 'request_id', 'status', 'reason_code', 'scope', 'provider', 'model', 'duration_ms', 'attempts', 'cached', 'usage', 'counts', 'scores', 'contract_version']);
const USAGE_FIELDS = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cached_input_tokens', 'review_input_tokens', 'review_output_tokens', 'review_reasoning_tokens', 'review_cached_input_tokens', 'review_total_tokens']);

function safeMetricMap(value, field) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} must be a flat metric object.`);
  const output = {};
  for (const [key, metric] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || (field === 'usage' && !USAGE_FIELDS.has(key))) throw new TypeError(`Unsupported ${field} metric.`);
    if (!(metric === null || typeof metric === 'boolean' || (typeof metric === 'number' && Number.isFinite(metric)))) throw new TypeError(`${field} metrics must be numbers, booleans, or null.`);
    output[key] = metric;
  }
  return output;
}

function endpoint(value) {
  if (!value) return null;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError('Hook endpoints must be credential-free HTTP(S) URLs.');
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new TypeError('Remote hook endpoints must use HTTPS.');
  return parsed.href;
}

export function sanitizeHookEvent(event) {
  if (!EVENT_TYPES.has(event?.event_type)) throw new TypeError('Unsupported hook event type.');
  const safe = {};
  for (const [key, value] of Object.entries(event)) {
    if (!SAFE_FIELDS.has(key) || value === undefined) continue;
    if (['usage', 'counts', 'scores'].includes(key)) safe[key] = safeMetricMap(value, key);
    else if (typeof value === 'string') safe[key] = value.slice(0, 500);
    else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') safe[key] = value;
    else throw new TypeError(`Unsupported hook field value: ${key}.`);
  }
  safe.contract_version = 'quiz-hook-v1';
  safe.occurred_at ||= new Date().toISOString();
  const serialized = JSON.stringify(safe);
  if (serialized.length > 16_384) throw new RangeError('Hook event exceeds the metadata-only size limit.');
  return Object.freeze(safe);
}

export function createHookDispatcher({ observabilityEndpoint, evaluationEndpoint, fetchImpl = globalThis.fetch, timeoutMs = 2_000 } = {}) {
  const endpoints = Object.freeze({ observability: endpoint(observabilityEndpoint), evaluation: endpoint(evaluationEndpoint) });
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  async function emit(kind, event) {
    const target = endpoints[kind];
    if (!target) return { delivered: false, reason: 'disabled' };
    try {
      const body = sanitizeHookEvent(event);
      const response = await fetchImpl(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      return response.ok ? { delivered: true, status: response.status } : { delivered: false, reason: 'http_error', status: response.status };
    } catch (error) {
      return { delivered: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'transport_error' };
    }
  }
  return Object.freeze({ endpoints, emitObservability: (event) => emit('observability', event), emitEvaluation: (event) => emit('evaluation', event) });
}

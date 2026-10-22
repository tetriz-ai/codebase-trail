// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHookDispatcher, sanitizeHookEvent } from './telemetry-hooks.mjs';

test('hooks are disabled by default and never block generation', async () => {
  const hooks = createHookDispatcher({ fetchImpl: async () => { throw new Error('must not call'); } });
  assert.deepEqual(await hooks.emitObservability({ event_type: 'generation.completed' }), { delivered: false, reason: 'disabled' });
});

test('hook payloads allow only metadata and omit source, prompt, and answers', async () => {
  let sent;
  const hooks = createHookDispatcher({ observabilityEndpoint: 'https://example.test/events', fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return { ok: true, status: 204 }; } });
  const outcome = await hooks.emitObservability({ event_type: 'generation.completed', status: 'published', model: 'm', source: 'secret code', prompt: 'secret prompt', answer: 'secret answer' });
  assert.deepEqual(outcome, { delivered: true, status: 204 });
  assert.equal(sent.status, 'published');
  assert.equal(sent.source, undefined); assert.equal(sent.prompt, undefined); assert.equal(sent.answer, undefined);
});

test('hook configuration rejects embedded credentials and unknown events', () => {
  assert.throws(() => createHookDispatcher({ observabilityEndpoint: 'https://user:pass@example.test' }), /credential-free/);
  assert.throws(() => sanitizeHookEvent({ event_type: 'raw.source' }), /Unsupported/);
});

test('nested metrics cannot smuggle prompts or source', async () => {
  const hooks = createHookDispatcher({ observabilityEndpoint: 'https://example.test/events', fetchImpl: async () => ({ ok: true, status: 204 }) });
  assert.deepEqual(await hooks.emitObservability({ event_type: 'generation.completed', scores: { prompt: 'secret' } }), { delivered: false, reason: 'transport_error' });
  assert.throws(() => sanitizeHookEvent({ event_type: 'generation.completed', usage: { source_content: 1 } }), /Unsupported/);
  assert.deepEqual(sanitizeHookEvent({ event_type: 'generation.completed', usage: { input_tokens: 10, output_tokens: 4, reasoning_tokens: 2, cached_input_tokens: 3, total_tokens: 14, review_input_tokens: 5, review_output_tokens: 2, review_reasoning_tokens: 1, review_cached_input_tokens: 0, review_total_tokens: 7 } }).usage, { input_tokens: 10, output_tokens: 4, reasoning_tokens: 2, cached_input_tokens: 3, total_tokens: 14, review_input_tokens: 5, review_output_tokens: 2, review_reasoning_tokens: 1, review_cached_input_tokens: 0, review_total_tokens: 7 });
});

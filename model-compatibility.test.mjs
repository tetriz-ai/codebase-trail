// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleModelProvider } from './providers/model/openai-compatible.mjs';
import { modelCompatibilityCases } from './scripts/model-compatibility-cases.mjs';

for (const [family, model, supported] of modelCompatibilityCases) test(`${family} OpenRouter request uses advertised fields`, async () => {
  const requests = [];
  const provider = new OpenAICompatibleModelProvider({
    endpoint: 'https://openrouter.ai/api/v1', model, reasoningEffort: 'low',
    fetch: async (url, options) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: model, supported_parameters: supported }] }));
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
    },
  });
  const result = await provider.completeJson({ messages: [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: 'Confirm.' }], schema: { type: 'object' }, maxTokens: 256 });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.model, model);
  assert.equal(request.max_completion_tokens === 256, supported.includes('max_completion_tokens'));
  assert.equal(request.max_tokens === 256, !supported.includes('max_completion_tokens'));
  assert.equal(Object.hasOwn(request, 'temperature'), supported.includes('temperature'));
  assert.equal(Object.hasOwn(request, 'response_format'), supported.includes('response_format'));
  assert.equal(request.reasoning_effort === 'low', supported.includes('reasoning_effort'));
  assert.equal(request.reasoning?.effort === 'low', !supported.includes('reasoning_effort'));
});

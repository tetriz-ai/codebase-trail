// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeModelProvider } from './providers/model/native.mjs';
import { loadConfig, publicConfig } from './config.mjs';
import { createConfiguredModelProvider } from './server.mjs';

const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
const request = { messages: [{ role: 'system', content: 'Follow the schema.' }, { role: 'user', content: 'Return true.' }], schema, schemaName: 'quiz', maxTokens: 512 };
const replies = {
  openai: { model: 'gpt-test', status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: { input_tokens: 10, output_tokens: 5 } },
  anthropic: { model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 10, output_tokens: 5 } },
  vertex: { modelVersion: 'gemini-test', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
};

for (const provider of ['openai', 'anthropic', 'vertex']) test(`${provider} native transport maps request and response`, async () => {
  let captured;
  const client = new NativeModelProvider({ provider, endpoint: provider === 'vertex' ? 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models' : `https://api.${provider}.com/v1`, model: `${provider}-test`, apiKeyEnv: 'MODEL_KEY', env: { MODEL_KEY: 'secret' }, fetch: async (url, options) => { captured = { url, options }; return new Response(JSON.stringify(replies[provider])); } });
  const result = await client.completeJson(request);
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(result.outputCharacters > 0, true);
  assert.equal(JSON.stringify(client).includes('secret'), false);
  const body = JSON.parse(captured.options.body);
  assert.equal(captured.options.redirect, 'error');
  if (provider === 'openai') { assert.match(captured.url, /\/responses$/); assert.deepEqual(body.text.format.schema, schema); assert.equal(captured.options.headers.authorization, 'Bearer secret'); }
  if (provider === 'anthropic') { assert.match(captured.url, /\/messages$/); assert.deepEqual(body.output_config.format.schema, schema); assert.equal(body.system, 'Follow the schema.'); assert.equal(body.tool_choice, undefined); assert.equal(captured.options.headers['x-api-key'], 'secret'); }
  if (provider === 'vertex') { assert.match(captured.url, /vertex-test:generateContent$/); assert.deepEqual(body.generationConfig.responseJsonSchema, schema); assert.equal(body.systemInstruction.parts[0].text, 'Follow the schema.'); }
});

test('native providers classify truncation, credential and HTTP failures', async () => {
  const make = (provider, fetch, env = { MODEL_KEY: 'secret' }) => new NativeModelProvider({ provider, endpoint: 'https://api.example/v1', model: 'm', apiKeyEnv: 'MODEL_KEY', env, fetch });
  await assert.rejects(make('openai', async () => new Response('{}'), {}).completeJson(request), { code: 'model_provider_credential_missing', retryable: false });
  await assert.rejects(make('openai', async () => new Response(JSON.stringify({ error: { message: 'secret' } }), { status: 429 })).completeJson(request), (error) => error.code === 'model_provider_http_error' && error.retryable && !error.message.includes('secret'));
  await assert.rejects(make('openai', async () => new Response('<html>private</html>', { status: 401 })).completeJson(request), (error) => error.code === 'model_provider_http_error' && error.status === 401 && error.retryable === false && !error.message.includes('private'));
  await assert.rejects(make('anthropic', async () => new Response(JSON.stringify({ stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 2 } }))).completeJson(request), { code: 'model_output_truncated' });
});

test('configuration selects native providers and isolates a distinct reviewer', async () => {
  const openai = await loadConfig({ env: { CODE_LEARNING_MODEL_PROVIDER: 'openai', CODE_LEARNING_MODEL: 'gpt-test' } });
  assert.equal(openai.model.endpoint, 'https://api.openai.com/v1');
  assert.equal(openai.model.reviewProvider, 'openai');
  assert.equal(publicConfig(openai).model.credential.required, true);
  const anthropic = await loadConfig({ env: { CODE_LEARNING_MODEL_PROVIDER: 'anthropic', CODE_LEARNING_MODEL: 'claude-test' } });
  assert.equal(anthropic.model.apiKeyEnv, 'ANTHROPIC_API_KEY');
  await assert.rejects(loadConfig({ env: { CODE_LEARNING_MODEL_PROVIDER: 'vertex' } }), /model.endpoint is required/);
  const vertex = await loadConfig({ overrides: { model: { provider: 'vertex', endpoint: 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models', model: 'gemini-test' } } });
  assert.equal(vertex.model.apiKeyEnv, 'GOOGLE_CLOUD_ACCESS_TOKEN');
  await assert.rejects(loadConfig({ overrides: { model: { provider: 'vertex', endpoint: 'https://vertex.example/v1', model: 'gemini-test' } } }), /model.endpoint must identify/);
  await assert.rejects(loadConfig({ overrides: { model: { provider: 'anthropic', authMode: 'bearer' } } }), /authMode is incompatible/);
  const mixed = await loadConfig({ overrides: { model: { provider: 'openai', model: 'gpt-test', reviewProvider: 'anthropic', reviewEndpoint: 'https://api.anthropic.com/v1', reviewModel: 'claude-test', reviewAuthMode: 'x-api-key', reviewApiKeyEnv: 'ANTHROPIC_API_KEY' } } });
  assert.equal(mixed.model.reviewProvider, 'anthropic');
  assert.equal(mixed.model.reviewApiKeyEnv, 'ANTHROPIC_API_KEY');
  assert.equal(createConfiguredModelProvider(mixed.model).id, 'openai');
  assert.equal(createConfiguredModelProvider(mixed.model, 'review').id, 'anthropic');
  assert.equal(createConfiguredModelProvider(mixed.model, 'review').authMode, 'x-api-key');
});

test('OpenAI native schema omits unsupported string length keywords', async () => {
  let body;
  const client = new NativeModelProvider({ provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-test', apiKeyEnv: 'MODEL_KEY', env: { MODEL_KEY: 'secret' }, fetch: async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify(replies.openai)); } });
  await client.completeJson({ ...request, schema: { ...schema, properties: { ok: { type: 'string', minLength: 1, maxLength: 10 } } } });
  assert.deepEqual(body.text.format.schema.properties.ok, { type: 'string' });
});

test('Anthropic native JSON output omits unsupported string length keywords', async () => {
  let body;
  const client = new NativeModelProvider({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'claude-test', apiKeyEnv: 'MODEL_KEY', env: { MODEL_KEY: 'secret' }, fetch: async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify(replies.anthropic)); } });
  await client.completeJson({ ...request, schema: { ...schema, properties: { ok: { type: 'string', minLength: 1, maxLength: 10 } } } });
  assert.deepEqual(body.output_config.format.schema.properties.ok, { type: 'string' });
  assert.equal('tool_choice' in body, false);
});

test('Anthropic disabled schema mode parses a plain JSON text response', async () => {
  let body;
  const client = new NativeModelProvider({ provider: 'anthropic', endpoint: 'https://api.anthropic.com/v1', model: 'claude-test', apiKeyEnv: 'MODEL_KEY', jsonSchema: 'disabled', env: { MODEL_KEY: 'secret' }, fetch: async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' })); } });
  assert.deepEqual((await client.completeJson(request)).value, { ok: true });
  assert.equal('tools' in body, false);
});

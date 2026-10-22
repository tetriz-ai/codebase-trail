// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.mjs';
import { discoverModels } from './settings-store.mjs';
import { OpenAICompatibleModelProvider } from './providers/model/openai-compatible.mjs';
import { createHookDispatcher } from './telemetry-hooks.mjs';
import { setLaunchRuntime } from './launcher-runtime.mjs';
import { createServer } from 'node:http';

const endpoint = 'http://[::1]:11434/v1';
test('IPv6 loopback is accepted by generator, reviewer and model discovery policies', async () => {
  const config = await loadConfig({ env: {}, overrides: { model: { endpoint, sourceEgress: 'local', authMode: 'none', apiKeyEnv: null, reviewEndpoint: endpoint, reviewSourceEgress: 'local' } } });
  assert.equal(config.model.endpoint, endpoint);
  assert.equal(config.model.reviewEndpoint, endpoint);
  assert.doesNotThrow(() => new OpenAICompatibleModelProvider({ endpoint, model: 'fixture', authMode: 'none', apiKeyEnv: null }));
  const models = await discoverModels({ provider: 'openai-compatible', endpoint, authMode: 'none', credential: '', fetcher: async (url) => { assert.equal(url, `${endpoint}/models`); return Response.json({ data: [{ id: 'fixture' }] }); } });
  assert.deepEqual(models.models, ['fixture']);
});

test('IPv6 nonloopback HTTP endpoints remain rejected', async () => {
  const remote = 'http://[::2]:11434/v1';
  await assert.rejects(loadConfig({ env: {}, overrides: { model: { endpoint: remote } } }), /HTTPS/);
  await assert.rejects(loadConfig({ env: {}, overrides: { model: { reviewEndpoint: remote } } }), /HTTPS/);
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: remote, model: 'fixture' }), /HTTPS/);
  await assert.rejects(discoverModels({ provider: 'openai-compatible', endpoint: remote, authMode: 'none', credential: '', fetcher: async () => { throw new Error('Must reject before fetch'); } }), /HTTPS/);
  assert.throws(() => createHookDispatcher({ observabilityEndpoint: remote }), /HTTPS/);
});

test('IPv6 loopback telemetry delivers metadata through an injected fake', async () => {
  const hooks = createHookDispatcher({ observabilityEndpoint: `${endpoint}/events`, fetchImpl: async (url, request) => { assert.equal(url, `${endpoint}/events`); assert.equal(JSON.parse(request.body).event_type, 'generation.completed'); return { ok: true, status: 204 }; } });
  assert.deepEqual(await hooks.emitObservability({ event_type: 'generation.completed' }), { delivered: true, status: 204 });
});

test('status classifies IPv6 generator and reviewer as local', async () => {
  const config = await loadConfig({ env: {}, overrides: { model: { endpoint, sourceEgress: 'local', authMode: 'none', apiKeyEnv: null } } });
  setLaunchRuntime({ config, env: {} });
  let server;
  try {
    const { createApp, uiApiToken } = await import(`./server.mjs?ipv6-loopback=${Date.now()}`);
    server = createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/status`, { headers: { 'x-code-learning-token': uiApiToken } });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.model_provider.execution, 'local');
    assert.equal(status.reviewer_provider.execution, 'local');
    assert.equal(status.privacy.execution, 'local');
  } finally {
    setLaunchRuntime(null);
    if (server) await new Promise((resolve) => server.close(resolve));
  }
});

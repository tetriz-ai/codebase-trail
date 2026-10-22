// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { createApp, createConcurrencyGate, createArchitecturePracticeGenerator, createDogfoodArchitectureGenerator, uiApiToken } from './server.mjs';

async function withServer(dependencies, run) {
  const server = createServer(createApp(dependencies));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address(); const host = `127.0.0.1:${port}`; const origin = `http://${host}`;
    const call = ({ path, method = 'GET', body, headers = {} }) => new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { host, 'x-code-learning-token': uiApiToken, 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}), ...headers } }, (response) => {
        const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json; try { json = JSON.parse(raw); } catch { json = undefined; }
          resolve({ status: response.statusCode, headers: response.headers, raw, json });
        });
      });
      request.on('error', reject); if (body !== undefined) request.write(body); request.end();
    });
    await run(call);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

const historyStore = {
  async list(options) { return [{ id: 'one', options }]; },
  async exportPortable() { return { schema_version: 1, records: [] }; },
  async importPortable(payload) { return { imported: payload.records?.length || 0, duplicates: 0 }; },
};

test('HTTP routes validate inputs and preserve stable public failure contracts', async () => {
  const events = []; const calls = [];
  await withServer({
    history_store: historyStore,
    load_candidates: async () => [{ number: 7 }],
    analyze_architecture_repositories: (payload) => ({ accepted: payload.repositories.length }),
    generate_architecture: async (payload) => ({ status: 'published', item: { scope: payload.scope, learning_level: payload.learning_level } }),
    generate_architecture_practice: async (payload) => ({ status: 'published', item: { scope: payload.scope, learning_level: payload.learning_level } }),
    resolve_candidate: async (number, randomize, selection) => { calls.push({ number, randomize, selection }); return { number: number || 7 }; },
    generate_pr: async (number, level, stage) => ({ status: 'published', number, level, stage }),
    emit_generation_event: (result, scope) => events.push([result.status, scope]),
  }, async (call) => {
    const status = await call({ path: '/api/status' });
    assert.equal(status.status, 200);
    assert.equal(status.json.model_provider.contract, 'OpenAI-compatible Chat Completions');
    assert.equal(status.json.reviewer_provider.contract, 'OpenAI-compatible Chat Completions');
    assert.equal(status.json.privacy.source_egress, null);
    assert.equal(status.json.privacy.generator_source_egress, null);
    assert.equal(status.json.privacy.reviewer_source_egress, null);
    assert.deepEqual((await call({ path: '/api/candidates' })).json, [{ number: 7 }]);
    assert.equal((await call({ path: '/api/history?limit=2&offset=1&query=x' })).json.records[0].options.limit, 2);
    assert.equal((await call({ path: '/api/history/export' })).json.schema_version, 1);
    assert.deepEqual((await call({ path: '/api/history/import', method: 'POST', body: '{"schema_version":1,"records":[]}' })).json, { imported: 0, duplicates: 0 });
    assert.deepEqual((await call({ path: '/api/architecture/analyze', method: 'POST', body: '{"repositories":[{}]}' })).json, { accepted: 1 });
    assert.equal((await call({ path: '/api/architecture/generate', method: 'POST', body: '{"scope":"lld"}' })).json.item.scope, 'lld');

    for (const invalid of [{}, { scope: 'unknown' }, { scope: 'lld', learning_level: 'expert' }, { scope: 'lld', learner_node_ids: 'x' }, { scope: 'lld', learner_node_ids: [''] }, { scope: 'lld', learner_node_ids: Array(21).fill('x') }]) {
      const response = await call({ path: '/api/architecture/dogfood/generate', method: 'POST', body: JSON.stringify(invalid) });
      assert.equal(response.status, 400);
    }
    const dogfood = await call({ path: '/api/architecture/dogfood/prefetch', method: 'POST', body: '{"scope":"service"}' });
    assert.equal(dogfood.status, 200); assert.equal(dogfood.json.prefetched, true);
    assert.ok(['foundational', 'applied', 'systems'].includes(dogfood.json.item.learning_level));

    const invalidPrBodies = [
      { pr_number: 0 }, { learning_level: 'expert' }, { selection_strategy: 'random' },
      { exclude_pr_numbers: [0] }, { prior_pr_numbers: '7' }, { mental_model_focus: 'yes' },
      { prior_questions: [{ pr_number: 0, question: 'x' }] },
      { prior_questions: Array.from({ length: 101 }, () => ({ pr_number: 1, question: 'x' })) },
    ];
    for (const body of invalidPrBodies) assert.equal((await call({ path: '/api/generate', method: 'POST', body: JSON.stringify(body) })).status, 400);
    const generated = await call({ path: '/api/generate', method: 'POST', body: '{"pr_number":7,"prior_pr_numbers":[7],"selection_strategy":"spaced_recall"}' });
    assert.equal(generated.status, 200); assert.equal(generated.json.stage, 'intentional_review');
    assert.ok(['foundational', 'applied', 'systems'].includes(generated.json.level));
    assert.equal(calls.length, 1);
    assert.deepEqual(events, [['published', 'architecture'], ['published', 'service'], ['published', 'pr']]);

    assert.equal((await call({ path: '/api/generate', method: 'POST', body: '{bad' })).status, 400);
    assert.equal((await call({ path: '/missing' })).status, 404);
  });
});

test('HTTP route failures redact internal diagnostics and retain status semantics', async () => {
  const originalError = console.error; console.error = () => {};
  try {
    await withServer({
      history_store: { ...historyStore, async list() { throw new Error('/private/history.json'); }, async exportPortable() { throw new Error('/private/history.json'); } },
      load_candidates: async () => { throw new Error('gh stderr secret'); },
      load_architecture_snapshots: async () => { throw new Error('checkout /private/example-repository'); },
      analyze_architecture_repositories: () => { throw new Error('raw source leaked'); },
      generate_architecture: async () => { const error = new Error('bad request details'); error.statusCode = 400; error.code = 'invalid_scope'; throw error; },
      generate_architecture_practice: async () => { const error = new Error('busy'); error.statusCode = 429; error.code = 'generation_capacity_exceeded'; throw error; },
      resolve_candidate: async () => ({ number: 1 }),
      generate_pr: async () => { throw new Error('provider key sk-secret'); },
    }, async (call) => {
      const checks = [
        ['/api/history', 'GET', undefined, 400, 'history_query_invalid'],
        ['/api/history/export', 'GET', undefined, 500, 'history_export_failed'],
        ['/api/candidates', 'GET', undefined, 502, 'candidate_load_failed'],
        ['/api/architecture/catalog', 'GET', undefined, 502, 'architecture_catalog_failed'],
        ['/api/architecture/analyze', 'POST', '{}', 400, 'architecture_request_invalid'],
        ['/api/architecture/generate', 'POST', '{}', 400, 'invalid_scope'],
        ['/api/architecture/dogfood/generate', 'POST', '{"scope":"lld"}', 429, 'generation_capacity_exceeded'],
        ['/api/generate', 'POST', '{}', 502, 'learning_generation_failed'],
      ];
      for (const [path, method, body, status, code] of checks) {
        const response = await call({ path, method, body });
        assert.equal(response.status, status, path); assert.equal(response.json.error_code, code, path);
        assert.doesNotMatch(response.raw, /private|secret|provider key|raw source|checkout/, path);
      }
    });
  } finally { console.error = originalError; }
});

test('HTTP boundary rejects missing capability, hostile origins, media types, and oversized bodies', async () => {
  const originalError = console.error; console.error = () => {};
  try { await withServer({ history_store: historyStore }, async (call) => {
    assert.equal((await call({ path: '/api/status', headers: { 'x-code-learning-token': '' } })).status, 403);
    assert.equal((await call({ path: '/api/status', headers: { origin: 'https://evil.test' } })).status, 403);
    assert.equal((await call({ path: '/api/status', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await call({ path: '/api/history/import', method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
    const oversized = JSON.stringify({ padding: 'x'.repeat(9 * 1024 * 1024) });
    const response = await call({ path: '/api/history/import', method: 'POST', body: oversized });
    assert.equal(response.status, 400);
    assert.equal(response.json.error_code, 'history_import_invalid');
  }); } finally { console.error = originalError; }
});

test('HTTP prefetch and foreground requests coalesce before reserving generation capacity', async () => {
  let release; let analyzed = 0; let generations = 0; let allAnalyzed;
  const ready = new Promise((resolve) => { allAnalyzed = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const values = new Map(); const gate = createConcurrencyGate(1);
  const generate = createArchitecturePracticeGenerator({
    load_snapshots: async () => [],
    analyze: async () => { if (++analyzed === 4) allAnalyzed(); return { graph: { buildId: 'fixture-build' } }; },
    generate: async (payload) => { generations++; await pending; return { status: 'published', item: { scope: payload.scope, learning_level: payload.learning_level }, architecture: {} }; },
    cache: { async get(id, dimensions) { return values.get(JSON.stringify(dimensions)); }, async set(id, dimensions, value) { values.set(JSON.stringify(dimensions), value); } },
    inflight: new Map(), generation_gate: gate,
  });
  await withServer({ generate_architecture_practice: generate, emit_generation_event: () => {} }, async (call) => {
    const requests = [['prefetch', 'shared'], ['generate', 'shared'], ['prefetch', 'shared'], ['generate', 'fresh']].map(([action, selection_id]) => call({ path: `/api/architecture/dogfood/${action}`, method: 'POST', body: JSON.stringify({ scope: 'lld', selection_id }) }));
    let deadline;
    try {
      await Promise.race([ready, new Promise((resolve) => { deadline = setTimeout(resolve, 1_000); })]);
      assert.equal(generations, 1);
    } finally { clearTimeout(deadline); release(); }
    const responses = await Promise.all(requests);
    assert.ok(responses.every((response) => response.status === 200), JSON.stringify(responses.map(({ status, json }) => ({ status, json }))));
    assert.equal(generations, 2);
    assert.equal(new Set(responses.slice(0, 3).map((response) => response.json.item.learning_level)).size, 1);
    assert.equal(gate.active, 0);
  });
});

test('original architecture file types are rejected before redaction or generation', async (t) => {
  const { analyzeArchitectureRepositories, generateArchitectureLearningItem, sanitizeArchitectureRepositories } = await import('./server.mjs');
  const snapshot = (file) => ({ repositories: [{ repository_id: 'example/repo', revision: 'abc', tree_complete: true, files: [file] }], scope: 'lld' });
  const invalid = [undefined, null, 42, ['hello'], false].map((content) => snapshot({ path: 'schema.sql', complete: true, content }));
  invalid.push(snapshot(null), snapshot(['not-a-file']), { repositories: [null] }, { repositories: {} }, { repositories: [{ repository_id: 'example/repo', revision: 'abc', files: {} }] });
  let modelCalls = 0;
  await t.test('analyzer validates the original input', () => {
    for (const payload of invalid) assert.throws(() => analyzeArchitectureRepositories(payload), /repositories|repository|file/i);
  });
  await t.test('generation validates before analysis or model calls', async () => {
    for (const payload of invalid) await assert.rejects(generateArchitectureLearningItem(payload, { complete_json: () => { modelCalls++; throw new Error('MODEL_MUST_NOT_RUN'); } }), /repositories|repository|file/i);
  });
  assert.equal(modelCalls, 0);
  const incomplete = snapshot({ path: 'schema.sql', complete: false });
  assert.equal(analyzeArchitectureRepositories(incomplete).graph.complete, false);
  const safe = sanitizeArchitectureRepositories(snapshot({ path: 'schema.sql', content: 'CREATE TABLE jobs(id int);', complete: true }).repositories);
  assert.equal(safe[0].files[0].content, 'CREATE TABLE jobs(id int);');
  const originalError = console.error; console.error = () => {};
  try {
    await t.test('HTTP rejects malformed snapshots without reflecting content', async () => withServer({}, async (call) => {
      for (const payload of invalid) {
        const response = await call({ path: '/api/architecture/analyze', method: 'POST', body: JSON.stringify(payload) });
        assert.equal(response.status, 400);
        assert.deepEqual(response.json, { error: 'Architecture analysis request is invalid.', error_code: 'architecture_request_invalid' });
        assert.doesNotMatch(response.raw, /schema.sql|hello|not-a-file/);
      }
    }));
  } finally { console.error = originalError; }
});


test('repository-neutral practice routes share generation and prefetch behavior with legacy routes', async () => {
  assert.equal(createArchitecturePracticeGenerator, createDogfoodArchitectureGenerator);
  for (const dependency of ['generate_architecture_practice', 'generate_dogfood_architecture']) {
  await withServer({ [dependency]: async (payload) => ({ status: 'published', item: { scope: payload.scope } }), emit_generation_event: () => {} }, async (call) => {
    for (const prefix of ['practice', 'dogfood']) {
      for (const action of ['generate', 'prefetch']) {
        const result = await call({ path: `/api/architecture/${prefix}/${action}`, method: 'POST', body: '{"scope":"lld"}' });
        assert.equal(result.status, 200);
        assert.equal(result.json.item.scope, 'lld');
        assert.equal(result.json.prefetched, action === 'prefetch');
      }
    }
  });
  }
});

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import './scripts/test-safety.mjs';
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';

const calls = [];
let server; let scenario;
const secret = 'synthetic-private-value-for-redaction';
const quote = 'import { worker } from "./worker.js";';
function fixture(number, overrides = {}) {
  scenario = { number, revision: number.toString(16).padStart(40, '0'), ...overrides };
  calls.length = 0;
  return scenario;
}
function gh(args) {
  calls.push(args);
  const { number, revision } = scenario;
  if (scenario.error) throw new Error('synthetic gh stderr must remain private');
  const pull = { number, title: 'Use a worker boundary', body: `password=${secret}`, mergedAt: '2026-01-01T00:00:00Z', url: `https://github.com/fixture/pr/pull/${number}`, author: { login: 'fixture-author' }, mergeCommit: scenario.unmerged ? null : { oid: revision }, baseRefName: 'main', changedFiles: 1 };
  if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pull);
  if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([pull]);
  if (args[0] === 'api' && args[1] === 'user') return 'fixture-author';
  const endpoint = args.at(-1);
  if (endpoint.includes('/pulls/')) return JSON.stringify([[{ filename: 'src/api.js', status: 'modified', additions: 2, deletions: 0, patch: `@@ -1 +1,2 @@\n+${quote}\n+// password=${secret}` }]]);
  if (endpoint.includes('/git/trees/')) {
    assert.ok(endpoint.includes(revision));
    return JSON.stringify({ truncated: Boolean(scenario.truncated), tree: ['src/api.js', 'src/worker.js', 'package.json', '.env'].map((path) => ({ path, type: 'blob' })) });
  }
  if (endpoint.includes('/contents/')) {
    assert.ok(endpoint.endsWith(`?ref=${revision}`));
    const path = endpoint.split('/contents/')[1].split('?')[0];
    assert.notEqual(path, '.env');
    if (scenario.missing && path === 'src/api.js') throw new Error('synthetic unavailable blob');
    const content = { 'src/api.js': `${quote}\n// password=${secret}\n${scenario.oversized ? '// padding\n'.repeat(2000) : ''}`, 'src/worker.js': 'export const worker = () => 1;\n', 'package.json': '{"name":"fixture","type":"module"}' }[path];
    assert.equal(typeof content, 'string', `Unexpected file ${path}`);
    return content;
  }
  throw new Error(`Unexpected fake gh arguments: ${JSON.stringify(args)}`);
}
before(async () => {
  process.env.CORE_REPO = 'fixture/pr';
  const original = childProcess.execFile;
  const injected = (command, args, options, callback) => {
    if (command !== 'gh') return original(command, args, options, callback);
    queueMicrotask(() => { try { callback(null, gh(args), ''); } catch (error) { callback(error, '', error.message); } });
  };
  injected[promisify.custom] = (...args) => new Promise((resolve, reject) => injected(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
  childProcess.execFile = injected; syncBuiltinESMExports();
  try { server = await import('./server.mjs'); }
  finally { childProcess.execFile = original; syncBuiltinESMExports(); }
});

test('real PR acquisition pins metadata, patches, manifests and bounded imported neighbors', async () => {
  const { number, revision } = fixture(101);
  const input = await server.buildEvidenceBundle(number);
  const bundle = input.evidence_bundle;
  assert.equal(bundle.repository_revision, revision);
  assert.ok(bundle.sources.every((source) => source.revision === revision));
  assert.ok(bundle.sources.some(({ kind }) => kind === 'pr_metadata'));
  assert.ok(bundle.sources.some(({ kind, content }) => kind === 'diff' && content.includes(quote)));
  for (const path of ['src/api.js', 'src/worker.js', 'package.json']) assert.ok(input.retrieval.retrieved_paths.includes(path), path);
  assert.equal(input.retrieval.graph_complete, true);
  assert.ok(input.architecture_map.relationships.length > 0);
  assert.ok(input.exclusions.some(({ reason }) => reason === 'architecture_secret_content_redacted'));
  assert.ok(!JSON.stringify(input).includes(secret));
  assert.ok(calls.filter((args) => args.at(-1).includes('/contents/')).length <= 3);
});

test('incomplete, truncated and failed acquisition cannot claim a complete architecture', async () => {
  for (const [number, options, reason] of [[102, { missing: true }, 'changed_snapshot_unavailable'], [103, { oversized: true }, 'changed_snapshot_truncated'], [104, { truncated: true }, null]]) {
    fixture(number, options);
    const input = await server.buildEvidenceBundle(number);
    assert.equal(input.retrieval.graph_complete, false);
    if (reason) assert.ok(input.exclusions.some((entry) => entry.reason === reason));
    assert.ok(!input.allowed_question_types.includes('architecture_flow'));
  }
  fixture(105, { unmerged: true });
  await assert.rejects(server.buildEvidenceBundle(105), /merge commit/);
  fixture(106, { error: true });
  await assert.rejects(server.buildEvidenceBundle(106), /synthetic gh stderr/);
});

const review = { decision: 'pass', critique: 'No blocking issues.', answer_key_consistent: true, exactly_one_defensible: true, mental_model_transferable: true, avoids_identifier_trivia: true, scenario_distinct: true, evidence_grounded: true, learner_prose_concise: true };
test('HTTP generation acquires real pinned evidence before fake model completion and redacts acquisition errors', async () => {
  const { number, revision } = fixture(107);
  let modelCalls = 0;
  const complete = async (_system, user, _schema, name) => {
    assert.ok(!user.includes(secret));
    modelCalls += 1;
    if (name === 'code_learning_adversarial_review_v1') return { value: review, model: 'fake-reviewer' };
    const input = JSON.parse(user.match(/<UNTRUSTED_INPUT>\n([\s\S]+)\n<\/UNTRUSTED_INPUT>/)[1]);
    const source = input.evidence_bundle.sources.find((entry) => entry.kind === 'source_file' && entry.path_or_url === 'src/api.js');
    assert.ok(source.content.includes(quote));
    return { model: 'fake-generator', value: {
      question_type: 'mental_model', question_format: 'scenario_prediction', mental_model: 'Imports define a change boundary.', context: 'An API imports a worker.', immediate_work_payoff: 'Recognize which caller can be affected.',
      question: 'Which caller can be affected by a worker change?', answer_a: 'The API importing the worker.', answer_b: 'Every unrelated service.', answer_c: 'No caller can be affected.', correct_option_id: 'A', key_concepts: 'dependency|change boundary',
      explanation: 'The API imports the worker, so worker changes can affect that caller.', answer_analysis: 'A is uniquely correct because the API imports the worker. B fails because unrelated services have no proven dependency. C fails because the import establishes a dependency.', supporting_source_ids: source.source_id, evidence_quotes: `${source.source_id}::${quote}`, architecture_ref: 'none',
    } };
  };
  const http = createServer(server.createApp({ generate_pr: (...args) => server.generateLearningItem(...args, { complete_json: complete }), emit_generation_event: () => {} }));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${http.address().port}`;
    const call = () => fetch(`${origin}/api/generate`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-code-learning-token': server.uiApiToken }, body: JSON.stringify({ pr_number: scenario.number }) });
    const response = await call(); const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.status, 'published', JSON.stringify(result));
    assert.equal(result.output.item.evidence_pin.repository_revision, revision);
    assert.ok(modelCalls >= 2);
    assert.ok(calls.some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === String(number)));
    fixture(108, { error: true });
    const failed = await call(); const raw = await failed.text();
    assert.equal(failed.status, 502); assert.match(raw, /learning_generation_failed/);
    assert.doesNotMatch(raw, /synthetic gh stderr|private/);
  } finally { await new Promise((resolve) => http.close(resolve)); }
});

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCoverageCount, architectureEvidenceView, architectureOutcome, compactArchitectureEvidence, generationRejectionOutcome, historyView, learnerSafeHistoryText, mergeHistoryRecords, parseHistoryImport, recordIdentity, runtimeStatus, storeFeedback, timingEntries, timingSummary } from './ui-logic.mjs';

test('keeps evidence abstention distinct from generation rejection', () => {
  const abstained = architectureOutcome({ status: 'abstained', reason_code: 'no_closed_path', analysis: { scopes: { hld: { evidence_pack: { claims: [{}, {}], paths: [{}] } } } } }, 'hld');
  assert.deepEqual(abstained, { kind: 'abstained', title: 'No HLD item published', reason: 'no_closed_path', claim_count: 2, path_count: 1 });
  const rejected = architectureOutcome({ status: 'rejected', reason_code: 'review_failed', rejection_stage: 'adversarial_review', validation_errors: ['identifier trivia'], generation_attempts: [{}, {}] }, 'lld');
  assert.equal(rejected.kind, 'rejected');
  assert.equal(rejected.stage, 'adversarial_review');
  assert.equal(rejected.attempts, 2);
  assert.deepEqual(rejected.validation_errors, ['identifier trivia']);
  assert.equal(architectureOutcome({ status: 'published' }, 'service').kind, 'published');
  assert.equal(architectureOutcome({ status: 'abstained', evidence_summary: { claim_count: 4, path_count: 2 } }, 'hld').path_count, 2);
});

test('explains generation rejection using the failing stage and actual generation count', () => {
  const outcome = generationRejectionOutcome({
    status: 'rejected', rejection_stage: 'deterministic_validation', validation_errors: ['Evidence quote was not exact.'],
    generation_attempts: [{ generation_attempt: 1, stage: 'adversarial_review' }, { generation_attempt: 2, stage: 'deterministic_validation' }],
  });
  assert.match(outcome.explanation, /deterministic grounding or format checks/);
  assert.equal(outcome.attempts, 2);
  assert.deepEqual(outcome.details, ['Evidence quote was not exact.']);
});

test('model HTTP errors point learners to the model settings they can repair', () => {
  const outcome = generationRejectionOutcome({ rejection_stage: 'generation', reason_code: 'model_provider_http_error' });
  assert.match(outcome.explanation, /model ID, API base URL, credential, and account access/);
});
test('restricted free model access gives a specific next step', () => {
  const outcome = generationRejectionOutcome({ rejection_stage: 'generation', reason_code: 'model_provider_access_restricted' });
  assert.match(outcome.explanation, /free model is limited to approved agentic harnesses/);
  assert.match(outcome.explanation, /Choose a model available to this app/);
});
test('model age confirmation gives the required account action', () => {
  const outcome = generationRejectionOutcome({ rejection_stage: 'generation', reason_code: 'model_provider_age_confirmation_required' });
  assert.match(outcome.explanation, /OpenRouter requires age confirmation/);
  assert.match(outcome.explanation, /Settings → Preferences/);
});
test('model timeouts identify whether generation or quality review needs tuning', () => {
  const generation = generationRejectionOutcome({ rejection_stage: 'generation', reason_code: 'model_provider_timeout' });
  const review = generationRejectionOutcome({ rejection_stage: 'adversarial_review_transport', reason_code: 'model_provider_timeout' });
  assert.match(generation.explanation, /question model/);
  assert.match(review.explanation, /quality reviewer/);
  assert.match(review.explanation, /reasoning effort in Settings/);
});

test('unrecognized CLI model IDs point to model selection', () => {
  const outcome = generationRejectionOutcome({ rejection_stage: 'generation', reason_code: 'model_cli_invalid_model' });
  assert.match(outcome.explanation, /model ID/);
  assert.match(outcome.explanation, /Settings/);
});

test('uses precise model failure codes in learner-facing rejection explanations', () => {
  assert.match(generationRejectionOutcome({ status: 'rejected', rejection_stage: 'generation', reason_code: 'local_transport_validation_failed' }).explanation, /local publication rule/);
  const outcome = generationRejectionOutcome({ status: 'rejected', rejection_stage: 'generation', reason_code: 'model_output_truncated', generation_attempts: [{ generation_attempt: 1 }, { generation_attempt: 2 }] });
  assert.match(outcome.explanation, /Maximum completion and Context window/);
  assert.equal(outcome.attempts, 2);
});

test('architecture feedback retains pins and compact references but drops raw excerpts and claim bodies', () => {
  const evidence = compactArchitectureEvidence({ graph_build_id: 'g1', revision_vector: [{ repository_id: 'repo', revision: 'abc' }], claims: [{ id: 'used', kind: 'http', statement: 'large raw claim', provenance: { classification: 'static' }, evidence: [{ repoId: 'repo', path: 'api/routes.ts', content: 'secret/raw source' }] }, { id: 'unused', evidence: [] }], paths: [{ id: 'p1', nodes: ['a', 'b'], raw: 'large traversal' }] }, { supporting_claim_ids: ['used'], evidence_pin: { graph_build_id: 'g1', claim_ids: ['used'] } });
  assert.deepEqual(evidence.supporting_claim_ids, ['used']);
  assert.deepEqual(evidence.claim_refs, [{ id: 'used', kind: 'http', provenance: 'static', evidence_refs: [{ repository_id: 'repo', path: 'api/routes.ts' }] }]);
  assert.deepEqual(evidence.path_refs, [{ path_id: 'p1', claim_ids: [] }]);
  assert.doesNotMatch(JSON.stringify(evidence), /secret|large raw|large traversal|unused/);
  assert.deepEqual(compactArchitectureEvidence({ paths: [['claim-a', 'claim-b']] }, {}).path_refs[0].claim_ids, ['claim-a', 'claim-b']);
});

test('builds repository-aware learner evidence without internal claim metadata', () => {
  const view = architectureEvidenceView({
    revision_vector: { one: 'abc', two: 'def' }, paths: [['claim-1', 'claim-2']],
    claims: [
      { id: 'claim-1', kind: 'imports_contract', sourceId: 'one::service::gateway', targetId: 'two::contract::shared_api', provenance: 'code_proven', evidence: [{ repository_id: 'one', revision: 'abc', path: 'src/client.ts', start_line: 4, end_line: 7 }] },
      { id: 'claim-2', kind: 'calls', sourceId: 'two::service::worker', targetId: 'one::service::gateway', evidence: [{ repository_id: 'two', revision: 'def', path: 'src/client.ts', start_line: 9, end_line: 9 }] },
    ],
  });
  assert.equal(view.file_count, 2);
  assert.equal(view.revision_count, 2);
  assert.equal(view.revision_copy, 'Checked against source files from 2 pinned repository revisions.');
  assert.deepEqual(view.relationships.map(({ label }) => label), ['gateway → shared api', 'worker → gateway']);
  assert.deepEqual(view.relationships.map(({ files }) => files[0].label), ['one · src/client.ts:4–7', 'two · src/client.ts:9']);
  assert.doesNotMatch(JSON.stringify(view), /claim-1|code_proven|abc|def/);
});

test('sanitizes legacy architecture history without changing PR prose or legitimate C4 terminology', () => {
  assert.equal(learnerSafeHistoryText('The graph shows gateway imports contract (C1).', { architecture: true }), 'The code establishes gateway imports contract.');
  assert.equal(learnerSafeHistoryText('The C4 model describes this boundary.', { architecture: true }), 'The C4 model describes this boundary.');
  assert.equal(learnerSafeHistoryText('C1 affects the caller.', { architecture: true, legacy: true }), 'the cited relationship affects the caller.');
  assert.equal(learnerSafeHistoryText('The graph shows C3 affects the caller.', { architecture: true }), 'The code establishes the cited relationship affects the caller.');
  assert.equal(learnerSafeHistoryText('The graph shows C1.', { architecture: false }), 'The graph shows C1.');
});

test('feedback storage reports quota and other write failures without claiming success', () => {
  const stored = new Map();
  assert.deepEqual(storeFeedback({ setItem: (key, value) => stored.set(key, value) }, 'feedback', [{ id: 1 }]), { ok: true });
  assert.equal(JSON.parse(stored.get('feedback'))[0].id, 1);
  assert.deepEqual(storeFeedback({ setItem: () => { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; } }, 'feedback', []), { ok: false, reason: 'storage_quota_exceeded' });
  assert.deepEqual(storeFeedback({ setItem: () => { throw new Error('disabled'); } }, 'feedback', []), { ok: false, reason: 'storage_write_failed' });
});

test('normalizes server timing telemetry without coupling the UI to one envelope', () => {
  assert.deepEqual(timingEntries({ timings: { evidence_selection: 1200, generation: 31_000, adversarial_review: 8500 } }), [
    { name: 'evidence selection', milliseconds: 1200 },
    { name: 'generation', milliseconds: 31_000 },
    { name: 'adversarial review', milliseconds: 8500 },
  ]);
  assert.equal(timingSummary({ telemetry: { stages: [{ stage: 'generation', duration_ms: 2400 }, { stage: 'adversarial_review', elapsed_ms: 11_000 }] } }), 'generation 2.4s · adversarial review 11s');
  assert.equal(timingSummary({}), '');
  assert.deepEqual(timingEntries({ timings: { generation: -1, review: 'unknown' } }), []);
});

test('history records are deduplicated deterministically and newest wins', () => {
  const older = { record_id: 'same', saved_at: '2025-01-01T00:00:00Z', generation: { question: { question: { text: 'Old wording' } } } };
  const newer = { record_id: 'same', saved_at: '2025-01-02T00:00:00Z', generation: { question: { question: { text: 'New wording' } } } };
  const other = { source_scope: 'hld', evidence: { graph_build_id: 'g1' }, saved_at: '2025-01-03T00:00:00Z', generation: { question: { question: 'Topology?' } } };
  assert.equal(recordIdentity(older), 'same');
  assert.match(recordIdentity(other), /^hld:g1:/);
  assert.deepEqual(mergeHistoryRecords([older], [newer, other]).map((record) => record.generation.question.question.text || record.generation.question.question), ['Topology?', 'New wording']);
});

test('history import accepts envelopes, reports rejected rows, and rejects malformed payloads', () => {
  const result = parseHistoryImport(JSON.stringify({ records: [{ record_id: 'one' }, null, { nope: true }] }));
  assert.equal(result.ok, true);
  assert.equal(result.records.length, 1);
  assert.equal(result.rejected_count, 2);
  assert.equal(parseHistoryImport('{').reason, 'invalid_json');
  assert.equal(parseHistoryImport({ questions: [] }).reason, 'records_missing');
  assert.equal(parseHistoryImport([{ no: 'identity' }]).reason, 'records_invalid');
});

test('history import accepts the durable store export shape', () => {
  const parsed = parseHistoryImport({ schema_version: 1, records: [{ id: 'q1', question: 'Who owns this boundary?', choices: ['api'], answer: 'api', updated_at: '2026-01-01T00:00:00Z', metadata: { scope: 'service' }, first_attempt: { correct: true } }] });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.records[0].record_id, 'q1');
  assert.equal(parsed.records[0].generation.question.question.text, 'Who owns this boundary?');
});

test('history view exposes compact learner-facing state without raw evidence', () => {
  const view = historyView([{ record_id: 'r1', saved_at: '2025-01-01T00:00:00Z', source_pr: { number: 42 }, learner_answer: { was_correct: false }, generation: { question: { question: { text: 'Where is the boundary?' } } }, evidence: { sources: ['secret'] } }]);
  assert.deepEqual(view, [{ id: 'r1', question: 'Where is the boundary?', source: 'PR #42', status: 'Review', saved_at: '2025-01-01T00:00:00Z' }]);
  assert.doesNotMatch(JSON.stringify(view), /secret/);
});

test('runtime status describes provider and source-egress posture', () => {
  assert.deepEqual(runtimeStatus({ model_provider: { name: 'Ollama', model: 'qwen' }, reviewer_provider: { name: 'OpenRouter', model: 'review-model' }, privacy: { execution: 'local', source_egress: false } }), { provider: 'Ollama · qwen', generator: 'Ollama · qwen', reviewer: 'OpenRouter · review-model', privacy: 'Local runtime · Source stays local', available: true });
  assert.equal(runtimeStatus({ model_provider: { name: 'Ollama', model: 'qwen' } }).reviewer, 'Same as question generator');
  assert.equal(runtimeStatus({ provider: 'OpenAI-compatible', privacy: { source_egress: true } }).privacy, 'Source may leave this device');
  assert.equal(runtimeStatus({ status: 'unavailable' }).available, false);
});

for (const [value, compact, exact] of [
  [0, '0', '0'], ['42', '42', '42'], ['999', '999', '999'],
  ['1000', '1 k', '1,000'], ['1250', '1.3 k', '1,250'],
  ['999000', '999 k', '999,000'], ['1000000', '1 mn', '1,000,000'],
  ['999000000', '999 mn', '999,000,000'], ['1000000000', '1 bn', '1,000,000,000'],
  ['999000000000', '999 bn', '999,000,000,000'], ['1000000000000', '1 tn', '1,000,000,000,000'],
  ['9007199254740993', '9007.2 tn', '9,007,199,254,740,993'],
]) test(`coverage count preserves compact and exact values for ${value}`, () => {
  assert.equal(formatCoverageCount(value), compact);
  assert.equal(formatCoverageCount(value, { exact: true }), exact);
});

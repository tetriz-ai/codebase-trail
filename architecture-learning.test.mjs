// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { architectureQuestionPin, buildArchitectureLearningInput, compactArchitectureGenerationEvidence, expandArchitectureTransport, materializeArchitectureEvidence, validateArchitectureLearningItem } from './architecture-learning.mjs';

const claim = { id: 'edge-1', sourceId: 'service-a', targetId: 'service-b', kind: 'calls', semanticStrength: 'statically_bound_call', provenance: 'code_proven', evidence: [{ path: 'client.go', commitSha: 'abc', contentHash: 'hash' }] };
const item = { scope: 'service', question_type: 'failure_propagation', mental_model_kind: 'failure_propagation', mental_model: 'Dependency failure crosses a boundary.', context: 'Service A synchronously depends on service B.', question: 'What happens at the service boundary if the dependency becomes unavailable?', answer_options: [{ id: 'A', text: 'The call fails.' }, { id: 'B', text: 'The dependency disappears.' }, { id: 'C', text: 'The contract changes.' }], correct_option_id: 'A', explanation: 'A synchronous dependency propagates failure unless handled. The caller must handle that failure at its boundary.', supporting_claim_ids: ['edge-1'] };

test('rejects an architecture question already answered in this scope', () => {
  const input = buildArchitectureLearningInput({ scope: 'service', eligible: true, graphBuildId: 'graph-1', revisions: {}, claims: [claim], paths: [] }, { priorQuestions: [item.question] });
  assert.ok(validateArchitectureLearningItem(item, input).some((error) => error.includes('previously answered')));
});

test('builds scope-specific service generation contracts and pins valid items', () => {
  const input = buildArchitectureLearningInput({ scope: 'service', eligible: true, graphBuildId: 'graph-1', revisions: { a: 'abc' }, claims: [claim], paths: [] });
  assert.ok(input.allowed_question_types.includes('failure_propagation'));
  assert.deepEqual(validateArchitectureLearningItem(item, input), []);
  assert.deepEqual(architectureQuestionPin(item, input).claim_ids, ['edge-1']);
});

test('requires multi-hop evidence for HLD and rejects identifier trivia', () => {
  const input = buildArchitectureLearningInput({ scope: 'hld', eligible: true, graphBuildId: 'graph-1', revisions: {}, claims: [claim], paths: [['edge-1']] });
  const hld = { ...item, scope: 'hld', question_type: 'system_flow', mental_model_kind: 'multi_service_flow', question: 'Which method named `sendRequest` is called?' };
  assert.ok(validateArchitectureLearningItem(hld, input).some((error) => error.includes('multi-hop')));
  assert.ok(validateArchitectureLearningItem(hld, input).some((error) => error.includes('identifier trivia')));
});

test('rejects private aliases and verbose explanations without rejecting legitimate C-number terminology', () => {
  const canonicalInput = buildArchitectureLearningInput({ scope: 'service', eligible: true, graphBuildId: 'graph-1', revisions: {}, claims: [claim], paths: [] });
  const aliasedInput = { ...canonicalInput, claims: canonicalInput.claims.map((entry) => ({ ...entry, claim_id: '__CLAIM_1__' })) };
  assert.ok(validateArchitectureLearningItem({ ...item, explanation: 'This follows from __claim-01__. The caller is affected.' }, aliasedInput).some((error) => error.includes('internal claim aliases')));
  assert.deepEqual(validateArchitectureLearningItem({ ...item, context: 'The repository documents its boundaries with the C4 model.' }, canonicalInput), []);
  assert.ok(validateArchitectureLearningItem({ ...item, explanation: 'The evidence shows that this service owns the route. The caller relies on it.' }, canonicalInput).some((error) => error.includes('evidence machinery')));
  assert.ok(validateArchitectureLearningItem({ ...item, explanation: 'Only one sentence is present.' }, canonicalInput).some((error) => error.includes('two or three')));
  assert.deepEqual(validateArchitectureLearningItem({ ...item, explanation: 'The service owns the route. Its caller depends on that boundary. A separate connector remains unaffected.' }, canonicalInput), []);
  assert.ok(validateArchitectureLearningItem({ ...item, explanation: 'One. Two. Three. Four.' }, canonicalInput).some((error) => error.includes('two or three')));
  assert.ok(validateArchitectureLearningItem({ ...item, explanation: `First consequence. ${'x'.repeat(601)}` }, canonicalInput).some((error) => error.includes('two or three')));
});

test('abstains when a scope has no closed evidence pack', () => {
  assert.deepEqual(buildArchitectureLearningInput({ scope: 'lld', eligible: false, reason: 'incomplete_graph' }), { decision: 'abstain', reason: 'incomplete_graph', scope: 'lld' });
});

test('materializes bounded revision-matched evidence and expands the shallow model transport', () => {
  const content = 'package client\nfunc call() {}';
  const pack = { evidence: [{ claimId: 'edge-1', repoId: 'repo', commitSha: 'abc', path: 'client.go', startLine: 1, endLine: 2, contentHash: createHash('sha256').update(content).digest('hex') }] };
  const excerpts = materializeArchitectureEvidence(pack, [{ repository_id: 'repo', revision: 'abc', files: [{ path: 'client.go', content, complete: true }] }]);
  assert.equal(excerpts[0].excerpt, 'package client\nfunc call() {}');
  const input = buildArchitectureLearningInput({ scope: 'service', eligible: true, graphBuildId: 'graph-1', revisions: {}, claims: [claim], paths: [] });
  const expanded = expandArchitectureTransport({ ...item, answer_a: 'A', answer_b: 'B', answer_c: 'C', supporting_claim_ids: 'edge-1' }, input);
  assert.equal(expanded.learning_level, input.learning_level);
  assert.deepEqual(validateArchitectureLearningItem(expanded, input), []);
});

test('omits empty package markers while retaining quotable evidence for the claim', () => {
  const empty = ''; const source = 'from package import handler\n';
  const pack = { evidence: [
    { claimId: 'edge-1', repoId: 'repo', commitSha: 'abc', path: 'package/__init__.py', startLine: 1, endLine: 1, contentHash: createHash('sha256').update(empty).digest('hex') },
    { claimId: 'edge-1', repoId: 'repo', commitSha: 'abc', path: 'consumer.py', startLine: 1, endLine: 1, contentHash: createHash('sha256').update(source).digest('hex') },
  ] };
  const excerpts = materializeArchitectureEvidence(pack, [{ repository_id: 'repo', revision: 'abc', files: [
    { path: 'package/__init__.py', content: empty, complete: true }, { path: 'consumer.py', content: source, complete: true },
  ] }]);
  assert.deepEqual(excerpts.map(({ path }) => path), ['consumer.py']);
});

test('rejects duplicate or stale evidence and requires HLD citations to cover a path', () => {
  const content = 'one\ntwo'; const contentHash = createHash('sha256').update(content).digest('hex');
  const pack = { evidence: [{ claimId: 'edge-1', repoId: 'repo', commitSha: 'abc', path: 'a.go', startLine: 1, endLine: 2, contentHash }] };
  assert.throws(() => materializeArchitectureEvidence(pack, [{ repository_id: 'repo', revision: 'abc', files: [{ path: 'a.go', content }, { path: 'a.go', content }] }]), /Duplicate repository file/);
  assert.throws(() => materializeArchitectureEvidence(pack, [{ repository_id: 'repo', revision: 'abc', files: [{ path: 'a.go', content }] }, { repository_id: 'repo', revision: 'def', files: [] }]), /Duplicate repository/);
  assert.throws(() => materializeArchitectureEvidence({ evidence: [{ ...pack.evidence[0], contentHash: 'stale' }] }, [{ repository_id: 'repo', revision: 'abc', files: [{ path: 'a.go', content }] }]), /hash mismatch/);
  assert.throws(() => materializeArchitectureEvidence({ claims: [{ id: 'edge-1', evidence: [pack.evidence[0]] }], evidence: [] }, []), /not closed/);
  const second = { ...claim, id: 'edge-2' };
  const input = buildArchitectureLearningInput({ scope: 'hld', eligible: true, graphBuildId: 'g', revisions: {}, claims: [claim, second], paths: [['edge-1', 'edge-2']] });
  const hld = { ...item, scope: 'hld', question_type: 'system_flow', mental_model_kind: 'multi_service_flow' };
  assert.ok(validateArchitectureLearningItem(hld, input).some((error) => error.includes('complete deterministic multi-hop path')));
  assert.deepEqual(validateArchitectureLearningItem({ ...hld, supporting_claim_ids: ['edge-1', 'edge-2'] }, input), []);
});

test('randomizes service evidence while preserving endpoint diversity, deduplication, and a total budget', () => {
  const claims = Array.from({ length: 7 }, (_, index) => ({
    claim_id: `edge-${index}`, from: `service-${index}`,
    to: `service-${index + 1}`,
    semantic_strength: index === 6 ? 'statically_bound_call' : 'convention_resolved',
    provenance: index === 6 ? 'code_proven' : 'inferred',
  }));
  const input = { decision: 'generate', scope: 'service', claims, paths: [] };
  const excerpts = claims.flatMap(({ claim_id }, index) => [
    { claim_id, repository_id: 'repo', revision: 'abc', path: `${index}.go`, start_line: 1, end_line: 2, excerpt: 'x'.repeat(140) },
    { claim_id, repository_id: 'repo', revision: 'abc', path: `${index}.go`, start_line: 1, end_line: 2, excerpt: 'x'.repeat(140) },
  ]);
  const compact = compactArchitectureGenerationEvidence(input, excerpts, { maxEvidenceChars: 500, random: () => 0.5 });
  assert.equal(compact.input.claims.length, 5);
  const alternate = compactArchitectureGenerationEvidence(input, excerpts, { random: () => 0.999 });
  assert.notDeepEqual(compact.input.claims, alternate.input.claims);
  assert.ok(compact.report.evidence_chars <= 500);
  assert.equal(compact.report.selected_excerpt_count, new Set(compact.excerpts.map(excerptKeyForTest)).size);
  assert.equal(compact.report.omitted_claim_count, 2);
});

test('excludes claims without quotable excerpts and keeps HLD paths atomic', () => {
  const claims = [
    { claim_id: 'edge-1', from: 'a', to: 'b' },
    { claim_id: 'edge-2', from: 'b', to: 'c' },
    { claim_id: 'edge-3', from: 'c', to: 'd' },
  ];
  const excerpts = [
    { claim_id: 'edge-1', path: 'a.py', excerpt: 'import b' },
    { claim_id: 'edge-2', path: 'empty.py', excerpt: '' },
    { claim_id: 'edge-3', path: 'c.py', excerpt: 'import d' },
  ];
  const lld = compactArchitectureGenerationEvidence({ decision: 'generate', scope: 'lld', claims, paths: [] }, excerpts, { random: () => 0.999 });
  assert.deepEqual(lld.input.claims.map(({ claim_id }) => claim_id), ['edge-3']);
  const hld = compactArchitectureGenerationEvidence({ decision: 'generate', scope: 'hld', claims, paths: [['edge-1', 'edge-2'], ['edge-2', 'edge-3']] }, excerpts);
  assert.deepEqual(hld.input.claims, []);
  assert.deepEqual(hld.input.paths, []);
});

const excerptKeyForTest = (entry) => JSON.stringify([entry.claim_id, entry.repository_id, entry.revision, entry.path, entry.start_line, entry.end_line, entry.excerpt]);

test('preserves an entire HLD path even when its claim count exceeds service limits', () => {
  const claims = Array.from({ length: 6 }, (_, index) => ({ claim_id: `hop-${index}`, from: `s${index}`, to: `s${index + 1}` }));
  const input = { decision: 'generate', scope: 'hld', claims, paths: [claims.map(({ claim_id }) => claim_id)] };
  const excerpts = claims.map(({ claim_id }, index) => ({ claim_id, path: `${index}.go`, excerpt: 'evidence'.repeat(20) }));
  const compact = compactArchitectureGenerationEvidence(input, excerpts, { maxEvidenceChars: 350 });
  assert.deepEqual(compact.input.claims.map(({ claim_id }) => claim_id), claims.map(({ claim_id }) => claim_id));
  assert.deepEqual(compact.input.paths, [claims.map(({ claim_id }) => claim_id)]);
  assert.equal(compact.report.hld_path_preserved, true);
  assert.ok(compact.report.evidence_chars <= 350);
});

test('sampling can reach the 41st claim', () => {
  const claims = Array.from({ length: 80 }, (_, i) => ({ claim_id: `claim-${i}`, from: `a-${i}`, to: `b-${i}` }));
  const input = { decision: 'generate', scope: 'lld', claims, paths: [] };
  const excerpts = claims.map(({ claim_id }) => ({ claim_id, path: 'main.go', excerpt: 'grounded source' }));
  const result = compactArchitectureGenerationEvidence(input, excerpts, { maxOtherClaims: 1, random: () => 0.999 });
  assert.deepEqual(result.input.claims.map(({ claim_id }) => claim_id), ['claim-79']);
  assert.equal(input.claims.length, 80);
  assert.equal(input.claims[0].claim_id, 'claim-0');
  assert.equal(result.report.omitted_claim_count, 79);
});

test('HLD sampling reaches the eleventh path', () => {
  const claims = Array.from({ length: 30 }, (_, i) => ({ claim_id: `claim-${i}`, from: `a-${i}`, to: `b-${i}` }));
  const paths = Array.from({ length: 15 }, (_, i) => [`claim-${2 * i}`, `claim-${2 * i + 1}`]);
  const input = { decision: 'generate', scope: 'hld', claims, paths };
  const excerpts = claims.map(({ claim_id }) => ({ claim_id, path: 'main.go', excerpt: 'grounded source' }));
  const first = compactArchitectureGenerationEvidence(input, excerpts, { random: () => 0.999 });
  const last = compactArchitectureGenerationEvidence(input, excerpts, { random: () => 0 });
  assert.deepEqual(first.input.paths, [paths[0]]);
  assert.deepEqual(last.input.paths, [paths.at(-1)]);
  assert.deepEqual(last.input.claims.map(({ claim_id }) => claim_id), paths.at(-1));
  assert.equal(input.paths.length, 15);
});

for (const scope of ['lld', 'service']) test(`${scope} sampling stays in one connected neighborhood without padding from disconnected claims`, () => {
  const claims = [
    { claim_id: 'ab', from: 'a', to: 'b' },
    { claim_id: 'cb', from: 'c', to: 'b' },
    { claim_id: 'cd', from: 'c', to: 'd' },
    { claim_id: 'xy', from: 'x', to: 'y' },
  ];
  const input = { decision: 'generate', scope, claims, paths: [] };
  const excerpts = claims.map(({ claim_id }) => ({ claim_id, path: 'main.go', excerpt: 'verified relationship' }));
  const first = compactArchitectureGenerationEvidence(input, excerpts, { random: () => 0 });
  assert.deepEqual(first.input.claims.map(({ claim_id }) => claim_id), ['ab', 'cb', 'cd']);
  assert.equal(first.input.claims[1].from, 'c');
  assert.equal(first.input.claims[1].to, 'b');
  assert.equal(first.report.anchor_node_id, 'a');
  assert.equal(first.report.selection_kind, 'connected_neighborhood');
  const isolated = compactArchitectureGenerationEvidence(input, excerpts, { random: () => 0.999 });
  assert.deepEqual(isolated.input.claims.map(({ claim_id }) => claim_id), ['xy']);
  assert.equal(input.claims.length, 4);
});

test('Service neighborhoods connect through service ownership even when component endpoints differ', () => {
  const claims = [
    { claim_id: 'ab', from: 'a/client', to: 'b/api', from_service_id: 'a', to_service_id: 'b' },
    { claim_id: 'bc', from: 'b/client', to: 'c/api', from_service_id: 'b', to_service_id: 'c' },
    { claim_id: 'xy', from: 'x/client', to: 'y/api', from_service_id: 'x', to_service_id: 'y' },
  ];
  const excerpts = claims.map(({ claim_id }) => ({ claim_id, path: 'main.go', excerpt: 'verified relationship' }));
  const service = compactArchitectureGenerationEvidence({ decision: 'generate', scope: 'service', claims, paths: [] }, excerpts, { random: () => 0 });
  assert.deepEqual(service.input.claims.map(({ claim_id }) => claim_id), ['ab', 'bc']);
  const lld = compactArchitectureGenerationEvidence({ decision: 'generate', scope: 'lld', claims, paths: [] }, excerpts, { random: () => 0 });
  assert.deepEqual(lld.input.claims.map(({ claim_id }) => claim_id), ['ab']);
});

test('connected sampling retains cycles and parallel claims within the prompt budget', () => {
  const claims = [
    { claim_id: 'ab1', from: 'a', to: 'b' }, { claim_id: 'ab2', from: 'a', to: 'b' },
    { claim_id: 'bc', from: 'b', to: 'c' }, { claim_id: 'ca', from: 'c', to: 'a' },
    { claim_id: 'aa', from: 'a', to: 'a' },
  ];
  const excerpts = claims.map(({ claim_id }) => ({ claim_id, path: 'main.go', excerpt: 'verified relationship' }));
  const result = compactArchitectureGenerationEvidence({ decision: 'generate', scope: 'lld', claims, paths: [] }, excerpts, { maxOtherClaims: 4, random: () => 0 });
  assert.equal(result.input.claims.length, 4);
  assert.equal(new Set(result.input.claims.map(({ claim_id }) => claim_id)).size, 4);
});

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMaintainerCorrections, architectureReleaseGate, evaluateArchitectureFixtures, isArchitectureClaimQuizEligible } from './architecture-governance.mjs';

const evidence = [{ repository_id: 'repo-a', revision: 'abc', path: 'ARCHITECTURE.md', line_start: 1, line_end: 2, content_hash: 'hash' }];

test('applies only authorized, versioned maintainer corrections', () => {
  const graph = { claims: [{ claim_id: 'doc-edge', source_id: 'a', target_id: 'b', provenance: 'documented', semantic_strength: 'documented_claim', resolution_state: 'unique', completeness: 'complete', evidence, quiz_eligible: false }] };
  const corrected = applyMaintainerCorrections(graph, [
    { correction_id: 'c1', claim_id: 'doc-edge', repository_id: 'repo-a', actor: 'outsider', action: 'confirm' },
    { correction_id: 'c2', claim_id: 'doc-edge', repository_id: 'repo-a', actor: 'owner', action: 'confirm' },
  ], { authorizedMaintainers: { 'repo-a': ['owner'] } });
  assert.equal(corrected.claims[0].review_state, 'maintainer_confirmed');
  assert.equal(corrected.claims[0].quiz_eligible, true);
  assert.deepEqual(corrected.correction_audit.map(({ applied }) => applied), [false, true]);
  assert.match(corrected.correction_version, /^[a-f0-9]{64}$/);
});

test('a rejection disables a claim', () => {
  const corrected = applyMaintainerCorrections({ claims: [{ claim_id: 'edge', source_id: 'a', target_id: 'b', provenance: 'code_proven', semantic_strength: 'declared_dependency', resolution_state: 'unique', completeness: 'complete', evidence, quiz_eligible: true }] }, [
    { correction_id: 'c1', claim_id: 'edge', repository_id: 'repo-a', actor: 'owner', action: 'reject' },
  ], { authorizedMaintainers: { 'repo-a': ['owner'] } });
  assert.equal(corrected.claims[0].quiz_eligible, false);
  assert.equal(corrected.claims[0].review_state, 'maintainer_rejected');
});

test('cross-repository semantic claims require confirmation from both endpoint owners', () => {
  const graph = { claims: [{ claim_id: 'cross', source_id: 'a', target_id: 'b', provenance: 'documented', semantic_strength: 'documented_claim', endpoint_repository_ids: ['repo-a', 'repo-b'], resolution_state: 'unique', completeness: 'complete', evidence }] };
  const authorization = { authorizedMaintainers: { 'repo-a': ['alice'], 'repo-b': ['bob'] } };
  const oneSided = applyMaintainerCorrections(graph, [{ correction_id: 'a', claim_id: 'cross', repository_id: 'repo-a', actor: 'alice', action: 'confirm' }], authorization);
  assert.equal(oneSided.claims[0].quiz_eligible, false);
  const bilateral = applyMaintainerCorrections(graph, [
    { correction_id: 'a', claim_id: 'cross', repository_id: 'repo-a', actor: 'alice', action: 'confirm' },
    { correction_id: 'b', claim_id: 'cross', repository_id: 'repo-b', actor: 'bob', action: 'confirm' },
  ], authorization);
  assert.equal(bilateral.claims[0].quiz_eligible, true);
});

test('central eligibility never lets corrections promote inferred or runtime claims', () => {
  const base = { source_id: 'a', target_id: 'b', resolution_state: 'unique', completeness: 'complete', evidence, review_state: 'maintainer_confirmed' };
  assert.equal(isArchitectureClaimQuizEligible({ ...base, provenance: 'runtime_observed', semantic_strength: 'statically_bound_call' }), false);
  assert.equal(isArchitectureClaimQuizEligible({ ...base, provenance: 'code_proven', semantic_strength: 'inferred' }), false);
  assert.equal(isArchitectureClaimQuizEligible({ ...base, provenance: 'documented', semantic_strength: 'documented_claim' }), true);
  assert.equal(isArchitectureClaimQuizEligible({ ...base, target_id: null, provenance: 'documented', semantic_strength: 'documented_claim' }), false);
});

test('rejects maintainer authority from a repository unrelated to claim evidence', () => {
  const graph = { claims: [{ claim_id: 'doc-edge', source_id: 'a', target_id: 'b', provenance: 'documented', semantic_strength: 'documented_claim', resolution_state: 'unique', completeness: 'complete', evidence }] };
  const corrected = applyMaintainerCorrections(graph, [{ correction_id: 'bad', claim_id: 'doc-edge', repository_id: 'unrelated', actor: 'mallory', action: 'confirm' }], { authorizedMaintainers: { unrelated: ['mallory'] } });
  assert.equal(corrected.claims[0].quiz_eligible, undefined);
  assert.equal(corrected.correction_audit[0].reason, 'repository_not_affected');
});

test('golden evaluation and release gates fail closed on empty or inaccurate graphs', () => {
  const exact = evaluateArchitectureFixtures([{ input: {}, expected_claim_ids: ['edge'], edge_classes: ['contract'] }], () => ({ claims: [{ claim_id: 'edge', quiz_eligible: true }] }));
  assert.equal(architectureReleaseGate(exact).passed, true);
  const empty = evaluateArchitectureFixtures([{ input: {}, expected_claim_ids: ['edge'] }], () => ({ claims: [] }));
  assert.equal(architectureReleaseGate(empty).passed, false);
  assert.ok(architectureReleaseGate(empty).failures.includes('representative_non_empty_fixtures_required'));
});

test('corrections synchronize review aliases and explicit rejection always wins', () => {
  const base = { claim_id: 'edge', source_id: 'a', target_id: 'b', provenance: 'code_proven', semantic_strength: 'declared_dependency', resolution_state: 'unique', completeness: 'complete', evidence, quizEligible: true };
  for (const aliases of [{ reviewState: 'not_required' }, { review_state: 'not_required' }, { reviewState: 'not_required', review_state: 'maintainer_rejected' }, { reviewState: 'maintainer_rejected', review_state: 'not_required' }]) {
    const original = { ...base, ...aliases };
    if (Object.values(aliases).includes('maintainer_rejected')) assert.equal(isArchitectureClaimQuizEligible(original), false);
    const corrected = applyMaintainerCorrections({ claims: [original] }, [{ correction_id: 'a', claim_id: 'edge', repository_id: 'repo-a', actor: 'owner', action: 'reject' }], { authorizedMaintainers: { 'repo-a': ['owner'] } }).claims[0];
    assert.equal(corrected.review_state, 'maintainer_rejected');
    if ('reviewState' in original) assert.equal(corrected.reviewState, 'maintainer_rejected');
    assert.equal(corrected.quizEligible, false);
    assert.equal(isArchitectureClaimQuizEligible(corrected), false);
    const graph = { claims: [{ ...original, provenance: 'documented', semantic_strength: 'documented_claim', endpoint_repository_ids: ['repo-a', 'repo-b'] }] };
    const corrections = ['repo-a', 'repo-b'].map((repository_id, i) => ({ correction_id: String(i), claim_id: 'edge', repository_id, actor: 'owner', action: 'confirm' }));
    const options = { authorizedMaintainers: { 'repo-a': ['owner'], 'repo-b': ['owner'] } };
    for (const count of [1, 2]) {
      const result = applyMaintainerCorrections(graph, corrections.slice(0, count), options).claims[0];
      assert.equal(result.quizEligible, count === 2);
      assert.equal(isArchitectureClaimQuizEligible(result), count === 2);
      if ('reviewState' in result) assert.equal(result.reviewState, result.review_state);
    }
  }
});

test('release gate rejects nonempty inaccurate graphs and accepts exact boundaries', () => {
  const report = (tp, fp, fn) => evaluateArchitectureFixtures([{ input: {}, expected_claim_ids: Array.from({ length: tp + fn }, (_, i) => `correct${i}`), edge_classes: ['imports'] }], () => ({ claims: [...Array.from({ length: tp }, (_, i) => `correct${i}`), ...Array.from({ length: fp }, (_, i) => `wrong${i}`)].map((claim_id) => ({ claim_id, quiz_eligible: true })) }));
  assert.deepEqual(architectureReleaseGate(report(1, 1, 0)), { passed: false, failures: ['imports:precision_below_threshold'] });
  assert.deepEqual(architectureReleaseGate(report(1, 0, 1)), { passed: false, failures: ['imports:recall_below_threshold'] });
  assert.equal(architectureReleaseGate(report(19, 1, 0)).passed, true);
  assert.equal(architectureReleaseGate(report(4, 0, 1)).passed, true);
  assert.equal(architectureReleaseGate(report(18, 1, 0)).passed, false);
  assert.equal(architectureReleaseGate(report(3, 0, 1)).passed, false);
  assert.equal(architectureReleaseGate(report(1, 1, 1), { minimumPrecision: 0.5, minimumRecall: 0.5 }).passed, true);
});

test('release gate rejects malformed counts, classes, metrics and thresholds', () => {
  const valid = { fixture_count: 1, non_empty: true, results: { imports: { fixtures: 1, true_positive: 1, false_positive: 0, false_negative: 0, precision: 1, recall: 1 } } };
  const invalid = [null, {}, { ...valid, results: {} }, { ...valid, results: [] }, { ...valid, results: { '': valid.results.imports } }, { ...valid, results: { imports: {} } }, { ...valid, results: { imports: null } }];
  for (const value of [0, -1, 0.5, NaN, Infinity, '1']) invalid.push({ ...valid, fixture_count: value });
  for (const value of [false, 'true', 1]) invalid.push({ ...valid, non_empty: value });
  for (const field of ['fixtures', 'true_positive', 'false_positive', 'false_negative']) for (const value of [undefined, -1, 0.5, NaN, Infinity, '1']) invalid.push({ ...valid, results: { imports: { ...valid.results.imports, [field]: value } } });
  invalid.push({ ...valid, results: { imports: { ...valid.results.imports, fixtures: 0 } } });
  invalid.push({ ...valid, results: { imports: { ...valid.results.imports, true_positive: 0, precision: 0, recall: 0 } } });
  for (const field of ['precision', 'recall']) for (const value of [undefined, null, NaN, Infinity, -0.1, 1.1, '1']) invalid.push({ ...valid, results: { imports: { ...valid.results.imports, [field]: value } } });
  for (const input of invalid) assert.equal(architectureReleaseGate(input).passed, false, JSON.stringify(input));
  for (const field of ['minimumPrecision', 'minimumRecall']) for (const value of [null, NaN, Infinity, -0.1, 1.1, '1']) assert.equal(architectureReleaseGate(valid, { [field]: value }).passed, false);
  assert.equal(architectureReleaseGate(valid, { minimumPrecision: 1, minimumRecall: 1 }).passed, true);
  assert.equal(architectureReleaseGate(valid, { minimumPrecision: 0, minimumRecall: 0 }).passed, true);
});

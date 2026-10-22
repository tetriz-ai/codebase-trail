// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessQuestionLifecycle, createQuestionEvidencePin, eligibleQuestions } from './question-lifecycle.mjs';

function input(overrides = {}) {
  const base = {
    contract_version: 'v2', policy_version: 'policy-v1', authorization_version: 'auth-v1', correction_version: 'correction-v1',
    retrieval: { repository_revision_indexed: true, repository_tree_truncated: false },
    evidence_bundle: {
      bundle_id: 'bundle-a', repository_id: 'example-org/app', repository_revision: 'abc123',
      sources: [{ source_id: 'source-a', path_or_url: 'api/service.go', revision: 'abc123', content: 'package api\n' }],
    },
    architecture_map: { map_id: 'graph-abc123', repository_revision: 'abc123', components: [{ component_id: 'api', source_ids: ['source-a'], resolution_state: 'unique' }], relationships: [] },
    graph_build: { build_id: 'build-abc123', completeness: 'complete', publication_state: 'publishable', revision_vector: { 'example-org/app': 'abc123' }, extractor_version: 'extractor-v1', policy_version: 'policy-v1' },
  };
  return { ...base, ...overrides };
}

test('pins a question to exact evidence content and graph revision', () => {
  const pin = createQuestionEvidencePin(input(), ['source-a']);
  assert.equal(pin.repository_revision, 'abc123');
  assert.equal(pin.sources[0].source_id, 'source-a');
  assert.match(pin.sources[0].content_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(pin.graph.revision_vector, { 'example-org/app': 'abc123' });
  assert.equal(pin.policy_versions.authorization_version, 'auth-v1');
  assert.deepEqual(assessQuestionLifecycle({ evidence_pin: pin }, input()), { eligible: true, state: 'current', reasons: [] });
});

test('invalidates an item when its evidence changes even at the same revision', () => {
  const original = input(); const pin = createQuestionEvidencePin(original, ['source-a']);
  const changed = input({ evidence_bundle: { ...original.evidence_bundle, sources: [{ ...original.evidence_bundle.sources[0], content: 'package changed\n' }] } });
  assert.deepEqual(assessQuestionLifecycle({ evidence_pin: pin }, changed).reasons, ['evidence_changed']);
});

test('invalidates an item when repository or graph revision advances', () => {
  const original = input(); const pin = createQuestionEvidencePin(original, ['source-a']);
  const advanced = input({
    evidence_bundle: { ...original.evidence_bundle, bundle_id: 'bundle-b', repository_revision: 'def456', sources: [{ ...original.evidence_bundle.sources[0], revision: 'def456' }] },
    architecture_map: { ...original.architecture_map, map_id: 'graph-def456', repository_revision: 'def456' },
    graph_build: { ...original.graph_build, build_id: 'build-def456', revision_vector: { 'example-org/app': 'def456' } },
  });
  const assessment = assessQuestionLifecycle({ evidence_pin: pin }, advanced);
  assert.equal(assessment.eligible, false);
  assert.ok(assessment.reasons.includes('repository_revision_changed'));
  assert.ok(assessment.reasons.includes('graph_revision_changed'));
});

test('fails closed for incomplete current evidence and excludes stale items', () => {
  const complete = input(); const current = { evidence_pin: createQuestionEvidencePin(complete, ['source-a']) };
  const legacy = { question: 'Unpinned question' };
  const incomplete = input({ retrieval: { repository_revision_indexed: true, repository_tree_truncated: true } });
  assert.throws(() => createQuestionEvidencePin(incomplete), /incomplete evidence/);
  assert.deepEqual(eligibleQuestions([current, legacy], complete), [current]);
  assert.deepEqual(eligibleQuestions([current], incomplete), []);
  assert.ok(assessQuestionLifecycle(current, incomplete).reasons.includes('repository_tree_incomplete'));
});

test('fails closed when the graph build is not publishable', () => {
  const incomplete = input({ graph_build: { build_id: 'build-bad', completeness: 'incomplete', publication_state: 'rejected' } });
  assert.throws(() => createQuestionEvidencePin(incomplete), /graph_build_not_publishable/);
});
test('pins source-only PR questions without claiming an incomplete graph is publishable', () => {
  const incomplete = input({ retrieval: { repository_revision_indexed: true, repository_tree_truncated: true }, graph_build: { build_id: 'build-bad', completeness: 'incomplete', publication_state: 'rejected' } });
  const pin = createQuestionEvidencePin(incomplete, ['source-a'], [], { requireCompleteGraph: false });
  assert.equal(pin.graph_required, false);
  assert.equal(pin.graph, null);
  assert.deepEqual(assessQuestionLifecycle({ evidence_pin: pin }, incomplete), { eligible: true, state: 'current', reasons: [] });
  assert.deepEqual(assessQuestionLifecycle({ evidence_pin: { ...pin, graph: { build_id: 'stale' } } }, incomplete).reasons, ['source_only_pin_has_graph']);
  assert.throws(() => createQuestionEvidencePin(incomplete, ['source-a'], ['api'], { requireCompleteGraph: false }), /cannot include architecture claims/);
});

test('rejects graph/source revision disagreement and duplicate sources', () => {
  const original = input();
  assert.throws(() => createQuestionEvidencePin({ ...original, graph_build: { ...original.graph_build, revision_vector: { 'example-org/app': 'wrong' } } }), /graph_build_evidence_revision_mismatch/);
  assert.throws(() => createQuestionEvidencePin({ ...original, evidence_bundle: { ...original.evidence_bundle, sources: [...original.evidence_bundle.sources, { ...original.evidence_bundle.sources[0] }] } }), /duplicate_source_id/);
  assert.throws(() => createQuestionEvidencePin({ ...original, evidence_bundle: { ...original.evidence_bundle, sources: [{ ...original.evidence_bundle.sources[0], revision: 'wrong' }] } }), /source_evidence_revision_mismatch/);
});

test('pins claims and invalidates on claim or policy changes', () => {
  const original = input(); const pin = createQuestionEvidencePin(original, ['source-a'], ['api']);
  assert.deepEqual(pin.claims.map(({ claim_id }) => claim_id), ['api']);
  const claimChanged = input({ architecture_map: { ...original.architecture_map, components: [{ ...original.architecture_map.components[0], role: 'changed' }] } });
  assert.ok(assessQuestionLifecycle({ evidence_pin: pin }, claimChanged).reasons.includes('architecture_claims_changed'));
  const policyChanged = input({ ...original, correction_version: 'correction-v2' });
  assert.ok(assessQuestionLifecycle({ evidence_pin: pin }, policyChanged).reasons.includes('policy_versions_changed'));
});

test('every evidence completeness invariant fails closed independently', () => {
  const original = input();
  const invalid = [
    [{ retrieval: { ...original.retrieval, repository_revision_indexed: false } }, 'repository_revision_not_indexed'],
    [{ evidence_bundle: { ...original.evidence_bundle, repository_revision: '' } }, 'evidence_revision_missing'],
    [{ architecture_map: { ...original.architecture_map, map_id: '' } }, 'graph_revision_missing'],
    [{ architecture_map: { ...original.architecture_map, repository_revision: 'other' } }, 'graph_evidence_revision_mismatch'],
    [{ graph_build: { ...original.graph_build, build_id: '' } }, 'graph_build_missing'],
    [{ graph_build: { ...original.graph_build, completeness: 'incomplete' } }, 'graph_build_not_publishable'],
    [{ graph_build: { ...original.graph_build, publication_state: 'rejected' } }, 'graph_build_not_publishable'],
    [{ evidence_bundle: { ...original.evidence_bundle, repository_id: '' } }, 'graph_build_evidence_revision_mismatch'],
    [{ graph_build: { ...original.graph_build, revision_vector: {} } }, 'graph_build_evidence_revision_mismatch'],
  ];
  for (const [override, reason] of invalid) assert.throws(() => createQuestionEvidencePin(input(override), ['source-a']), new RegExp(reason), reason);
  assert.throws(() => createQuestionEvidencePin(original, ['missing']), /unknown evidence sources/);
  assert.throws(() => createQuestionEvidencePin(original, []), /without evidence sources/);
  assert.throws(() => createQuestionEvidencePin(original, ['source-a'], ['missing']), /unknown architecture claim/);
});

test('lifecycle assessment reports unsupported pins and every independently changed identity', () => {
  const original = input(); const pin = createQuestionEvidencePin(original, ['source-a'], ['api']);
  assert.ok(assessQuestionLifecycle({}, original).reasons.includes('evidence_pin_missing_or_unsupported'));
  const cases = [
    [input({ evidence_bundle: { ...original.evidence_bundle, repository_id: 'other' }, graph_build: { ...original.graph_build, revision_vector: { other: 'abc123' } } }), 'repository_changed'],
    [input({ evidence_bundle: { ...original.evidence_bundle, bundle_id: 'bundle-other' } }), 'evidence_bundle_changed'],
    [input({ graph_build: { ...original.graph_build, build_id: 'build-other' } }), 'graph_build_changed'],
    [input({ graph_build: { ...original.graph_build, revision_vector: { 'example-org/app': 'abc123', other: 'def456' } } }), 'graph_revision_vector_changed'],
    [input({ architecture_map: { ...original.architecture_map, relationships: [{ relationship_id: 'r', from_component_id: 'api', to_component_id: 'api' }] } }), 'graph_changed'],
  ];
  for (const [current, reason] of cases) assert.ok(assessQuestionLifecycle({ evidence_pin: pin }, current).reasons.includes(reason), reason);
  const unavailable = input({ evidence_bundle: { ...original.evidence_bundle, sources: [] } });
  assert.ok(assessQuestionLifecycle({ evidence_pin: pin }, unavailable).reasons.includes('pinned_evidence_unavailable'));
});

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { architectureSmokeFailures, assertPrSmokeBundle } from './smoke-assertions.mjs';

test('architecture smoke assertions fail on incomplete and ineligible output', () => {
  const failures = architectureSmokeFailures('owner/repo', { tree_complete: false }, {
    graph: { complete: false, edges: [] },
    scopes: { lld: { evidence_pack: { eligible: false } } },
  }, { requiredScopes: ['lld'], minimumResolvedEdges: 1 });
  assert.deepEqual(failures, [
    'owner/repo: repository snapshot is incomplete',
    'owner/repo: organization graph is incomplete',
    'owner/repo: no architecture scope is eligible',
    'owner/repo: resolved edge count is below 1',
    'owner/repo: required lld scope is ineligible',
  ]);
});

test('PR smoke assertions require revision-pinned retrieved evidence', () => {
  const bundle = {
    evidence_bundle: { repository_revision: 'a'.repeat(40), sources: [{ kind: 'pr_metadata' }, { kind: 'diff' }] },
    retrieval: { retrieved_paths: ['src/app.ts'], graph_complete: false },
    architecture_map: { relationships: [] }, allowed_question_types: ['mental_model'],
  };
  assert.equal(assertPrSmokeBundle(bundle, 42, { expectedPaths: ['src/app.ts'], expectedQuestionTypes: ['mental_model'] }), 'a'.repeat(40));
  assert.throws(() => assertPrSmokeBundle({ ...bundle, retrieval: { retrieved_paths: [], graph_complete: false } }, 42), /did not retrieve/);
  assert.throws(() => assertPrSmokeBundle(bundle, 42, { requireGraphComplete: true }), /incomplete graph/);
});

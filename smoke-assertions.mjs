// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
export function architectureSmokeFailures(repositoryId, snapshot, analysis, { allowNoEligibleScope = false, minimumResolvedEdges = 1, requiredScopes = [] } = {}) {
  const failures = [];
  if (!snapshot.tree_complete) failures.push(`${repositoryId}: repository snapshot is incomplete`);
  if (!analysis.graph.complete) failures.push(`${repositoryId}: organization graph is incomplete`);
  const eligibleScopes = Object.entries(analysis.scopes).filter(([, value]) => value.evidence_pack.eligible).map(([scope]) => scope);
  if (!allowNoEligibleScope && !eligibleScopes.length) failures.push(`${repositoryId}: no architecture scope is eligible`);
  if (analysis.graph.edges.filter(({ resolution }) => resolution === 'resolved').length < minimumResolvedEdges) failures.push(`${repositoryId}: resolved edge count is below ${minimumResolvedEdges}`);
  for (const scope of requiredScopes) if (!analysis.scopes[scope]?.evidence_pack.eligible) failures.push(`${repositoryId}: required ${scope} scope is ineligible`);
  return failures;
}

export function assertPrSmokeBundle(bundle, pullNumber, { requireGraphComplete = false, minimumRelationships = 0, expectedPaths = [], expectedQuestionTypes = [] } = {}) {
  const revision = bundle.evidence_bundle.repository_revision;
  if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error(`PR #${pullNumber} did not resolve an immutable revision.`);
  if (!bundle.evidence_bundle.sources.some(({ kind }) => kind === 'pr_metadata')) throw new Error(`PR #${pullNumber} omitted PR metadata.`);
  if (!bundle.evidence_bundle.sources.some(({ kind }) => kind === 'diff')) throw new Error(`PR #${pullNumber} omitted changed-file patches.`);
  if (bundle.evidence_bundle.sources.length < 2) throw new Error(`PR #${pullNumber} did not acquire enough evidence.`);
  if (!bundle.retrieval.retrieved_paths.length) throw new Error(`PR #${pullNumber} did not retrieve any revision-pinned files.`);
  if (requireGraphComplete && !bundle.retrieval.graph_complete) throw new Error(`PR #${pullNumber} produced an incomplete graph.`);
  if (bundle.architecture_map.relationships.length < minimumRelationships) throw new Error(`PR #${pullNumber} produced fewer than ${minimumRelationships} architecture relationships.`);
  for (const expectedPath of expectedPaths) if (!bundle.retrieval.retrieved_paths.includes(expectedPath)) throw new Error(`PR #${pullNumber} did not retrieve expected path ${expectedPath}.`);
  for (const type of expectedQuestionTypes) if (!bundle.allowed_question_types.includes(type)) throw new Error(`PR #${pullNumber} did not allow expected question type ${type}.`);
  return revision;
}

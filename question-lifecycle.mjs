// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

const PIN_VERSION = 'question-evidence-pin-v2';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const policyVersions = (input) => ({
  contract_version: input?.contract_version || null,
  evidence_policy_version: input?.policy_version || input?.graph_build?.policy_version || null,
  extractor_version: input?.graph_build?.extractor_version || null,
  authorization_version: input?.authorization_version || 'authorization-v1',
  correction_version: input?.correction_version || 'none',
});

function sortedSources(sources, selectedIds) {
  const selected = selectedIds ? new Set(selectedIds) : null;
  return sources.filter(({ source_id }) => !selected || selected.has(source_id)).map(({ source_id, path_or_url, revision, content }) => ({
    source_id, path_or_url, revision: revision || null,
    content_sha256: createHash('sha256').update(String(content || '')).digest('hex'),
  })).sort((left, right) => left.source_id.localeCompare(right.source_id));
}

function claimsById(input) {
  return new Map([
    ...(input?.architecture_map?.components || []).map((claim) => [claim.component_id, { kind: 'component', claim }]),
    ...(input?.architecture_map?.relationships || []).map((claim) => [claim.relationship_id, { kind: 'relationship', claim }]),
  ]);
}

function sortedClaims(input, claimIds = []) {
  const available = claimsById(input);
  return [...new Set(claimIds)].sort().map((claimId) => {
    const found = available.get(claimId);
    if (!found) throw new Error(`Cannot pin unknown architecture claim: ${claimId}.`);
    return { claim_id: claimId, kind: found.kind, content_sha256: digest(found.claim) };
  });
}

function completenessErrors(input, requireCompleteGraph = true) {
  const errors = [];
  if (input?.retrieval?.repository_revision_indexed !== true) errors.push('repository_revision_not_indexed');
  if (!input?.evidence_bundle?.repository_revision) errors.push('evidence_revision_missing');
  if (requireCompleteGraph) {
    if (input?.retrieval?.repository_tree_truncated !== false) errors.push('repository_tree_incomplete');
    if (!input?.architecture_map?.map_id || !input?.architecture_map?.repository_revision) errors.push('graph_revision_missing');
    if (input?.architecture_map?.repository_revision !== input?.evidence_bundle?.repository_revision) errors.push('graph_evidence_revision_mismatch');
    if (!input?.graph_build?.build_id) errors.push('graph_build_missing');
    else if (input.graph_build.completeness !== 'complete' || input.graph_build.publication_state !== 'publishable') errors.push('graph_build_not_publishable');
    const repoId = input?.evidence_bundle?.repository_id;
    const vectorRevision = input?.graph_build?.revision_vector?.[repoId];
    if (!repoId || !vectorRevision || vectorRevision !== input?.evidence_bundle?.repository_revision) errors.push('graph_build_evidence_revision_mismatch');
  }
  const sources = input?.evidence_bundle?.sources || [];
  if (new Set(sources.map(({ source_id }) => source_id)).size !== sources.length) errors.push('duplicate_source_id');
  if (sources.some(({ revision }) => revision !== input?.evidence_bundle?.repository_revision)) errors.push('source_evidence_revision_mismatch');
  return errors;
}

export function createQuestionEvidencePin(input, sourceIds, claimIds = [], { requireCompleteGraph = true } = {}) {
  if (!requireCompleteGraph && claimIds.length) throw new Error('Source-only evidence pins cannot include architecture claims.');
  const errors = completenessErrors(input, requireCompleteGraph);
  if (errors.length) throw new Error(`Cannot pin question to incomplete evidence: ${errors.join(', ')}.`);
  const available = new Set(input.evidence_bundle.sources.map(({ source_id }) => source_id));
  const selectedIds = sourceIds ? [...new Set(sourceIds)].sort() : undefined;
  const missing = (selectedIds || []).filter((sourceId) => !available.has(sourceId));
  if (missing.length) throw new Error(`Cannot pin unknown evidence sources: ${missing.join(', ')}.`);
  const sources = sortedSources(input.evidence_bundle.sources, selectedIds);
  if (!sources.length) throw new Error('Cannot pin a question without evidence sources.');
  const claims = sortedClaims(input, claimIds);
  const graph = requireCompleteGraph ? {
    build_id: input.graph_build.build_id, map_id: input.architecture_map.map_id,
    repository_revision: input.architecture_map.repository_revision, revision_vector: input.graph_build.revision_vector,
    content_sha256: digest({ components: input.architecture_map.components || [], relationships: input.architecture_map.relationships || [] }),
  } : null;
  return {
    pin_version: PIN_VERSION, graph_required: requireCompleteGraph, repository_id: input.evidence_bundle.repository_id || null,
    repository_revision: input.evidence_bundle.repository_revision, evidence_bundle_id: input.evidence_bundle.bundle_id,
    evidence_sha256: digest(sources), graph, claims, policy_versions: policyVersions(input), sources,
  };
}

export function assessQuestionLifecycle(question, currentInput) {
  const pin = question?.evidence_pin || question?.lifecycle?.evidence_pin || question;
  const requireCompleteGraph = pin?.graph_required !== false;
  const reasons = completenessErrors(currentInput, requireCompleteGraph);
  if (pin?.pin_version !== PIN_VERSION) reasons.push('evidence_pin_missing_or_unsupported');
  if (!requireCompleteGraph && pin?.claims?.length) reasons.push('source_only_pin_has_architecture_claims');
  if (!requireCompleteGraph && pin?.graph !== null) reasons.push('source_only_pin_has_graph');
  if (reasons.length) return { eligible: false, state: 'invalidated', reasons: [...new Set(reasons)] };
  let currentPin;
  try {
    currentPin = createQuestionEvidencePin(currentInput, (pin.sources || []).map(({ source_id }) => source_id), (pin.claims || []).map(({ claim_id }) => claim_id), { requireCompleteGraph });
  } catch (error) {
    return { eligible: false, state: 'invalidated', reasons: ['pinned_evidence_unavailable'], detail: error.message };
  }
  const graphComparisons = requireCompleteGraph ? [
    ['graph_build_changed', pin.graph?.build_id, currentPin.graph.build_id], ['graph_revision_changed', pin.graph?.repository_revision, currentPin.graph.repository_revision],
    ['graph_revision_vector_changed', digest(pin.graph?.revision_vector), digest(currentPin.graph.revision_vector)], ['graph_changed', pin.graph?.content_sha256, currentPin.graph.content_sha256],
  ] : [];
  const comparisons = [
    ['repository_changed', pin.repository_id, currentPin.repository_id], ['repository_revision_changed', pin.repository_revision, currentPin.repository_revision],
    ['evidence_bundle_changed', pin.evidence_bundle_id, currentPin.evidence_bundle_id], ['evidence_changed', pin.evidence_sha256, currentPin.evidence_sha256],
    ...graphComparisons,
    ['architecture_claims_changed', digest(pin.claims), digest(currentPin.claims)], ['policy_versions_changed', digest(pin.policy_versions), digest(currentPin.policy_versions)],
  ];
  for (const [reason, previous, current] of comparisons) if (previous !== current) reasons.push(reason);
  return reasons.length ? { eligible: false, state: 'invalidated', reasons: [...new Set(reasons)] } : { eligible: true, state: 'current', reasons: [] };
}

export function eligibleQuestions(questions, currentInput) {
  return questions.filter((question) => assessQuestionLifecycle(question, currentInput).eligible);
}

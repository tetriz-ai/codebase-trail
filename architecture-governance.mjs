// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function sortedUnique(values = []) { return [...new Set(values)].sort(); }

const AUTOMATIC_PROVENANCE = new Set(['code', 'code_proven', 'deployment', 'deployment_declared']);
const REVIEWABLE_PROVENANCE = new Set(['documented']);
const AUTOMATIC_STRENGTH = new Set(['syntactic_import', 'declared_dependency', 'declared_reference', 'statically_bound_call', 'declared_contract']);
const REVIEWABLE_STRENGTH = new Set(['documented_claim', 'may_call']);

function claimValue(claim, camel, snake) { return claim[camel] ?? claim[snake]; }
function affectedRepositories(claim) {
  const explicit = claim.endpoint_repository_ids || claim.endpointRepositoryIds || [];
  const evidence = (claim.evidence || []).map((ref) => ref.repoId || ref.repository_id).filter(Boolean);
  const endpointIds = [claimValue(claim, 'sourceId', 'source_id') ?? claim.from, claimValue(claim, 'targetId', 'target_id') ?? claim.to]
    .map((id) => typeof id === 'string' && id.includes('::') ? id.split('::', 1)[0] : null).filter(Boolean);
  return sortedUnique([...explicit, ...evidence, ...endpointIds]);
}

/** The single fail-closed policy used by extraction, correction, and selection. */
export function isArchitectureClaimQuizEligible(claim) {
  const provenance = claim.provenance;
  const strength = claimValue(claim, 'semanticStrength', 'semantic_strength');
  const resolution = claimValue(claim, 'resolution', 'resolution_state');
  const review = [claim.reviewState, claim.review_state].includes('maintainer_rejected') ? 'maintainer_rejected' : claimValue(claim, 'reviewState', 'review_state');
  const source = claimValue(claim, 'sourceId', 'source_id') ?? claim.from ?? claim.from_component_id;
  const target = claimValue(claim, 'targetId', 'target_id') ?? claim.to ?? claim.to_component_id;
  const completeness = claim.completeness;
  const evidence = claim.evidence;
  const coordinateEvidenceClosed = Array.isArray(evidence) && evidence.length > 0 && evidence.every((ref) =>
    ref && (ref.repoId || ref.repository_id) && (ref.commitSha || ref.revision) && ref.path
      && Number(ref.startLine ?? ref.line_start ?? 0) > 0
      && Number(ref.endLine ?? ref.line_end ?? ref.startLine ?? ref.line_start ?? 0) >= Number(ref.startLine ?? ref.line_start ?? 0)
      && Boolean(ref.contentHash || ref.content_hash));
  const evidenceClosed = coordinateEvidenceClosed || (claim.evidence_closed === true && Array.isArray(claim.source_ids) && claim.source_ids.length > 0);
  if (!source || !target || !['resolved', 'unique'].includes(resolution) || completeness === 'incomplete' || !evidenceClosed) return false;
  if (AUTOMATIC_PROVENANCE.has(provenance) && AUTOMATIC_STRENGTH.has(strength)) return review !== 'maintainer_rejected';
  return REVIEWABLE_PROVENANCE.has(provenance) && REVIEWABLE_STRENGTH.has(strength) && review === 'maintainer_confirmed';
}

export function isArchitectureComponentQuizEligible(component) {
  const resolution = claimValue(component, 'resolution', 'resolution_state');
  const review = [component.reviewState, component.review_state].includes('maintainer_rejected') ? 'maintainer_rejected' : claimValue(component, 'reviewState', 'review_state');
  const sourceBacked = (Array.isArray(component.evidence) && component.evidence.length > 0)
    || (component.evidence_closed === true && Array.isArray(component.source_ids) && component.source_ids.length > 0);
  return sourceBacked && ['resolved', 'unique'].includes(resolution)
    && AUTOMATIC_PROVENANCE.has(component.provenance) && review !== 'maintainer_rejected';
}

export function applyMaintainerCorrections(graph, corrections = [], { authorizedMaintainers = {} } = {}) {
  const collectionKey = graph.claims ? 'claims' : graph.edges ? 'edges' : 'relationships';
  const byId = new Map((graph[collectionKey] || []).map((claim) => [claim.claim_id || claim.relationship_id || claim.id, { ...claim }]));
  const audit = []; const confirmations = new Map();
  for (const correction of corrections.slice().sort((a, b) => String(a.correction_id).localeCompare(String(b.correction_id)))) {
    const claim = byId.get(correction.claim_id); const owners = authorizedMaintainers[correction.repository_id] || [];
    const authorized = owners.includes(correction.actor);
    if (!claim || !authorized || !['confirm', 'reject'].includes(correction.action)) {
      audit.push({ correction_id: correction.correction_id, applied: false, reason: !claim ? 'claim_not_found' : !authorized ? 'actor_not_authorized' : 'invalid_action' });
      continue;
    }
    const requiredRepositories = affectedRepositories(claim);
    if (!requiredRepositories.length || !requiredRepositories.includes(correction.repository_id)) {
      audit.push({ correction_id: correction.correction_id, applied: false, reason: 'repository_not_affected' });
      continue;
    }
    if (correction.action === 'confirm') {
      const approved = confirmations.get(correction.claim_id) || new Set();
      approved.add(correction.repository_id); confirmations.set(correction.claim_id, approved);
      const completeApproval = requiredRepositories.every((repositoryId) => approved.has(repositoryId));
      claim.review_state = completeApproval ? 'maintainer_confirmed' : 'maintainer_confirmation_pending';
      if ('reviewState' in claim) claim.reviewState = claim.review_state;
      claim.quiz_eligible = completeApproval && isArchitectureClaimQuizEligible(claim);
      if ('quizEligible' in claim) claim.quizEligible = claim.quiz_eligible;
    } else {
      claim.review_state = 'maintainer_rejected'; claim.quiz_eligible = false;
      if ('reviewState' in claim) claim.reviewState = claim.review_state;
      if ('quizEligible' in claim) claim.quizEligible = false;
    }
    claim.correction_id = correction.correction_id;
    byId.set(correction.claim_id, claim);
    audit.push({ correction_id: correction.correction_id, repository_id: correction.repository_id, actor: correction.actor, action: correction.action, applied: true });
  }
  const claims = [...byId.values()];
  const correction_version = hash(audit);
  return { ...graph, [collectionKey]: claims, correction_version, correction_audit: audit };
}

export function evaluateArchitectureFixtures(fixtures, buildGraph) {
  const perClass = new Map();
  for (const fixture of fixtures) {
    const actual = buildGraph(fixture.input); const actualClaims = new Set((actual.claims || actual.edges || actual.relationships || []).filter((claim) => claim.quiz_eligible || claim.quizEligible).map((claim) => claim.claim_id || claim.relationship_id || claim.id));
    const expected = new Set(fixture.expected_claim_ids || []); const classes = fixture.edge_classes || ['all'];
    const tp = [...actualClaims].filter((id) => expected.has(id)).length;
    const fp = [...actualClaims].filter((id) => !expected.has(id)).length;
    const fn = [...expected].filter((id) => !actualClaims.has(id)).length;
    for (const edgeClass of classes) {
      const totals = perClass.get(edgeClass) || { true_positive: 0, false_positive: 0, false_negative: 0, fixtures: 0 };
      totals.true_positive += tp; totals.false_positive += fp; totals.false_negative += fn; totals.fixtures += 1; perClass.set(edgeClass, totals);
    }
  }
  const results = Object.fromEntries([...perClass].map(([edgeClass, totals]) => [edgeClass, {
    ...totals,
    precision: totals.true_positive / Math.max(1, totals.true_positive + totals.false_positive),
    recall: totals.true_positive / Math.max(1, totals.true_positive + totals.false_negative),
  }]));
  return { fixture_count: fixtures.length, non_empty: Object.values(results).some(({ true_positive, false_positive }) => true_positive + false_positive > 0), results };
}

export function architectureReleaseGate(report, { minimumPrecision = 0.95, minimumRecall = 0.8 } = {}) {
  const failures = [];
  const boundedMetric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!boundedMetric(minimumPrecision) || !boundedMetric(minimumRecall)) failures.push('valid_thresholds_required');
  const results = report?.results;
  const entries = results && typeof results === 'object' && !Array.isArray(results) ? Object.entries(results) : [];
  if (!count(report?.fixture_count) || report.fixture_count === 0 || report.non_empty !== true || !entries.length) failures.push('representative_non_empty_fixtures_required');
  let observedClaims = false;
  for (const [edgeClass, result] of entries) {
    if (!edgeClass.trim() || !result || typeof result !== 'object' || Array.isArray(result)
      || !count(result.fixtures) || result.fixtures === 0 || result.fixtures > report.fixture_count
      || !['true_positive', 'false_positive', 'false_negative'].every((field) => count(result[field]))
      || !boundedMetric(result.precision) || !boundedMetric(result.recall)) {
      failures.push(`${edgeClass}:valid_metrics_required`);
      continue;
    }
    observedClaims ||= result.true_positive > 0 || result.false_positive > 0;
    if (result.precision < minimumPrecision) failures.push(`${edgeClass}:precision_below_threshold`);
    if (result.recall < minimumRecall) failures.push(`${edgeClass}:recall_below_threshold`);
  }
  if (!observedClaims) failures.push('representative_non_empty_fixtures_required');
  return { passed: failures.length === 0, failures: sortedUnique(failures) };
}

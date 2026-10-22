// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { sampleServicePath } from './path-universe.mjs';

const SCOPE_TYPES = Object.freeze({
  lld: ['component_role', 'component_boundary', 'architecture_flow', 'contract_test_implication'],
  service: ['service_dependency', 'contract_compatibility', 'failure_propagation', 'change_impact'],
  hld: ['system_flow', 'architecture_tradeoff', 'blast_radius', 'failure_propagation'],
});

const SCOPE_MENTAL_MODELS = Object.freeze({
  lld: ['responsibility', 'boundary', 'invariant', 'control_flow', 'failure_mode'],
  service: ['dependency', 'contract', 'ownership', 'compatibility', 'failure_propagation'],
  hld: ['multi_service_flow', 'system_boundary', 'blast_radius', 'consistency', 'tradeoff'],
});

const claimId = (claim) => claim?.claim_id || claim?.id;
const excerptKey = (excerpt) => JSON.stringify([
  excerpt?.claim_id, excerpt?.repository_id, excerpt?.revision, excerpt?.path,
  excerpt?.start_line, excerpt?.end_line, excerpt?.excerpt,
]);

function explanationSentenceCount(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const withoutCommonAbbreviations = text.replace(/\b(?:e\.g|i\.e|vs|etc)\./gi, (match) => match.replaceAll('.', ''));
  const endings = withoutCommonAbbreviations.match(/[.!?]+(?=\s|$)/g)?.length || 0;
  return endings + (/[.!?]$/.test(withoutCommonAbbreviations) ? 0 : 1);
}

function exposesPrivateClaimAlias(value, claims) {
  const text = String(value || '');
  if (/_{1,2}\s*claim[\s_-]*0*[1-9]\d*\s*_{1,2}/i.test(text)) return true;
  return (claims || []).some(({ claim_id }) => {
    const id = String(claim_id || '');
    return id.startsWith('__CLAIM_') && text.toLocaleLowerCase().includes(id.toLocaleLowerCase());
  });
}

function shuffledClaims(claims, random) {
  const result = [...claims];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function connectedClaims(claims, scope, limit, random) {
  const endpoints = (claim) => scope === 'service'
    ? [claim.from_service_id || claim.from, claim.to_service_id || claim.to]
    : [claim.from, claim.to];
  const adjacency = new Map();
  for (const claim of claims) {
    const pair = endpoints(claim);
    if (pair.some((node) => !node)) continue;
    for (const node of new Set(pair)) {
      if (!adjacency.has(node)) adjacency.set(node, []);
      adjacency.get(node).push(claim);
    }
  }
  if (!adjacency.size || limit <= 0) return { claims: [], anchor: null };
  const nodes = [...adjacency.keys()];
  const anchor = nodes[Math.floor(random() * nodes.length)];
  const visited = new Set([anchor]); const queue = [anchor];
  const chosen = []; const seenClaims = new Set(); const deferred = [];
  // Traverse incoming and outgoing relationships to collect context around
  // the anchor. Original edge directions remain authoritative in the prompt.
  for (let index = 0; index < queue.length && chosen.length < limit; index += 1) {
    for (const claim of shuffledClaims(adjacency.get(queue[index]), random)) {
      const id = claimId(claim);
      if (seenClaims.has(id)) continue;
      seenClaims.add(id);
      const neighbors = endpoints(claim).filter((node) => !visited.has(node));
      if (!neighbors.length) { deferred.push(claim); continue; }
      chosen.push(claim);
      for (const node of neighbors) { visited.add(node); queue.push(node); }
      if (chosen.length >= limit) break;
    }
  }
  // Cycles, self references, and parallel edges may add useful evidence after
  // exploring neighbors. Never pad a small neighborhood with unrelated claims.
  for (const claim of shuffledClaims(deferred, random)) {
    if (chosen.length >= limit) break;
    chosen.push(claim);
  }
  return { claims: chosen, anchor };
}

/** Sample a small prompt from the full eligible universe. Keep HLD paths whole. */
export function compactArchitectureGenerationEvidence(input, excerpts, {
  maxServiceClaims = 5, maxOtherClaims = 8, maxEvidenceChars = 5_000, random = Math.random,
} = {}) {
  if (input?.decision !== 'generate') return { input, excerpts: [], report: { selected_claim_count: 0, selected_excerpt_count: 0, evidence_chars: 0, omitted_claim_count: 0, omitted_excerpt_count: excerpts?.length || 0 } };
  const claims = Array.isArray(input.claims) ? input.claims : [];
  const sourceExcerpts = Array.isArray(excerpts) ? excerpts : [];
  const materializedClaimIds = new Set(sourceExcerpts.filter((excerpt) => String(excerpt?.excerpt || '').trim()).map(({ claim_id }) => claim_id));
  const materializedClaims = claims.filter((claim) => materializedClaimIds.has(claimId(claim)));
  let selectedClaims;
  let selectedPaths = [];
  let anchorNodeId = null;
  if (input.scope === 'hld') {
    const eligibleIds = new Set(materializedClaims.map(claimId));
    // Sample the compact transition index without enumerating combinations.
    // Older explicit path inputs retain reservoir sampling compatibility.
    let path = input.path_universe ? sampleServicePath(input.path_universe, { eligibleClaimIds: eligibleIds, random }) : null;
    let eligiblePaths = 0;
    for (const candidate of input.path_universe ? [] : input.paths || []) {
      if (candidate.length < 2 || !candidate.every((id) => eligibleIds.has(id))) continue;
      eligiblePaths += 1;
      if (random() < 1 / eligiblePaths) path = candidate;
    }
    const ids = new Set(path || []);
    selectedClaims = materializedClaims.filter((claim) => ids.has(claimId(claim)));
    selectedPaths = path ? [path] : [];
  } else {
    const limit = input.scope === 'service' ? maxServiceClaims : maxOtherClaims;
    const neighborhood = connectedClaims(materializedClaims, input.scope, limit, random);
    const chosen = neighborhood.claims;
    anchorNodeId = neighborhood.anchor;
    const ids = new Set(chosen.map(claimId));
    selectedClaims = materializedClaims.filter((claim) => ids.has(claimId(claim)));
  }

  const selectedIds = new Set(selectedClaims.map(claimId));
  const unique = [...new Map(sourceExcerpts.filter((entry) => selectedIds.has(entry.claim_id)).map((entry) => [excerptKey(entry), entry])).values()];
  const byClaim = new Map(selectedClaims.map((claim) => [claimId(claim), []]));
  for (const excerpt of unique) byClaim.get(excerpt.claim_id)?.push(excerpt);
  const compact = []; let evidenceChars = 0;
  // Round-robin keeps evidence for both ends/multiple files of each selected
  // dependency instead of allowing the first verbose claim to consume budget.
  for (let round = 0; ; round += 1) {
    let found = false;
    const candidates = selectedClaims.map((claim) => byClaim.get(claimId(claim))?.[round]).filter(Boolean);
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const excerpt = candidates[candidateIndex];
      found = true;
      const remaining = maxEvidenceChars - evidenceChars;
      if (remaining <= 0) break;
      const text = String(excerpt.excerpt || '');
      if (!text) continue;
      // Divide the remaining budget across the rest of this round so every
      // selected dependency keeps at least one grounding excerpt.
      const fairShare = Math.max(1, Math.floor(remaining / (candidates.length - candidateIndex)));
      const bounded = text.slice(0, fairShare);
      compact.push({ ...excerpt, excerpt: bounded }); evidenceChars += bounded.length;
    }
    if (!found || evidenceChars >= maxEvidenceChars) break;
  }
  const { path_universe: _pathUniverse, ...promptInput } = input;
  return {
    input: { ...promptInput, claims: selectedClaims, paths: selectedPaths }, excerpts: compact,
    report: {
      selection_kind: input.scope === 'hld' ? 'complete_path' : 'connected_neighborhood', anchor_node_id: anchorNodeId,
      selected_claim_count: selectedClaims.length, selected_excerpt_count: compact.length,
      evidence_chars: evidenceChars, omitted_claim_count: claims.length - selectedClaims.length,
      omitted_excerpt_count: sourceExcerpts.length - compact.length, max_evidence_chars: maxEvidenceChars,
      hld_path_preserved: input.scope === 'hld' ? selectedPaths.length === 1 && selectedPaths[0].every((id) => selectedIds.has(id)) : null,
    },
  };
}

export function buildArchitectureLearningInput(pack, { learningLevel = 'systems', reviewStage = 'first_exposure', priorQuestions = [] } = {}) {
  if (!SCOPE_TYPES[pack?.scope]) throw new Error('Architecture learning scope must be lld, service, or hld.');
  if (!pack.eligible) return { decision: 'abstain', reason: pack.reason || `${pack.scope}_evidence_unavailable`, scope: pack.scope };
  const claims = pack.claims.map((claim) => ({
    claim_id: claim.id || claim.claim_id,
    from: claim.sourceId || claim.from,
    to: claim.targetId || claim.to,
    ...(claim.sourceServiceId && claim.targetServiceId ? { from_service_id: claim.sourceServiceId, to_service_id: claim.targetServiceId } : {}),
    relationship: claim.kind || claim.claim_kind,
    semantic_strength: claim.semanticStrength || claim.semantic_strength,
    provenance: claim.provenance,
    evidence: claim.evidence,
  }));
  return {
    decision: 'generate', contract_version: 'architecture-learning-v1', scope: pack.scope,
    learning_level: learningLevel, review_stage: reviewStage, prior_questions: priorQuestions, graph_build_id: pack.graphBuildId,
    revision_vector: pack.revisions, allowed_question_types: SCOPE_TYPES[pack.scope],
    allowed_mental_models: SCOPE_MENTAL_MODELS[pack.scope], claims, paths: pack.paths || [],
    ...(pack.path_universe ? { path_universe: pack.path_universe } : {}),
    generation_instruction: `Ask one ${pack.scope.toUpperCase()} reasoning question grounded only in the supplied claims. Focus on one coherent architectural situation and preserve the stated relationship directions; an import proves a dependency, not an execution order or runtime call. Match learning_level: foundational tests responsibilities and basic relationships; applied tests implementation choices and consequences; systems tests broader flows, failure modes, and trade-offs. Test a transferable boundary, invariant, flow, failure mode, compatibility rule, blast radius, or trade-off; never identifier recall.`,
  };
}

export function validateArchitectureLearningItem(item, input) {
  const errors = [];
  if (input?.decision !== 'generate') return ['generation input is not eligible'];
  if (item?.scope !== input.scope) errors.push('item scope does not match its evidence pack');
  if (!input.allowed_question_types.includes(item?.question_type)) errors.push('question type is not allowed for this architecture scope');
  if (!input.allowed_mental_models.includes(item?.mental_model_kind)) errors.push('mental model is not allowed for this architecture scope');
  if (typeof item?.question !== 'string' || !item.question.trim()) errors.push('question is required');
  const questionTokens = (value) => new Set(String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((token) => token.length > 2));
  const currentTokens = questionTokens(item?.question);
  if (currentTokens.size && (input.prior_questions || []).some((prior) => { const priorTokens = questionTokens(prior); const common = [...currentTokens].filter((token) => priorTokens.has(token)).length; return common / new Set([...currentTokens, ...priorTokens]).size >= 0.82; })) errors.push('question repeats a previously answered architecture question');
  for (const field of ['mental_model', 'context', 'explanation']) if (typeof item?.[field] !== 'string' || !item[field].trim()) errors.push(`${field} is required`);
  if (!Array.isArray(item?.answer_options) || item.answer_options.length !== 3) errors.push('exactly three answer options are required');
  const options = Array.isArray(item?.answer_options) ? item.answer_options : [];
  const optionIds = options.map(({ id }) => id);
  const optionTexts = options.map(({ text }) => typeof text === 'string' ? text.trim() : '');
  const learnerFacingText = [item?.mental_model, item?.context, item?.question, ...optionTexts, item?.explanation].filter((value) => typeof value === 'string').join('\n');
  if (exposesPrivateClaimAlias(learnerFacingText, input.claims)) errors.push('learner-facing text must not expose internal claim aliases');
  if (/\b(?:the\s+)?(?:graph|evidence|claims?|extract(?:ion|or))\s+(?:shows?|says?|proves?|indicates?)\b/i.test(learnerFacingText)) errors.push('learner-facing text must explain the architecture rather than evidence machinery');
  if (options.length === 3 && (new Set(optionIds).size !== 3 || !['A', 'B', 'C'].every((id) => optionIds.includes(id)))) errors.push('answer option IDs must be distinct A, B, and C');
  if (options.length === 3 && (optionTexts.some((text) => !text) || new Set(optionTexts).size !== 3)) errors.push('answer option text must be present and distinct');
  if (!optionIds.includes(item?.correct_option_id)) errors.push('correct option must identify an answer option');
  if (typeof item?.explanation === 'string' && (item.explanation.length > 600 || explanationSentenceCount(item.explanation) < 2 || explanationSentenceCount(item.explanation) > 3)) errors.push('explanation must contain two or three concise sentences');
  const knownClaims = new Set(input.claims.map(({ claim_id }) => claim_id));
  if (knownClaims.size !== input.claims.length || knownClaims.has(undefined)) errors.push('evidence pack claim IDs must be present and distinct');
  const cited = Array.isArray(item?.supporting_claim_ids) ? item.supporting_claim_ids : [];
  if (!cited.length || cited.some((id) => !knownClaims.has(id))) errors.push('supporting claims must come from the evidence pack');
  if (new Set(cited).size !== cited.length) errors.push('supporting claim IDs must be distinct');
  if (input.scope === 'hld' && !(input.paths || []).some((path) => path.length >= 2 && path.every((id) => cited.includes(id)))) errors.push('HLD questions must cite one complete deterministic multi-hop path');
  // Backticks and technical names can be necessary context. Deterministically
  // reject explicit recall wording; the adversarial semantic pass decides
  // whether answering actually depends on identifier trivia.
  if (/\b(?:method|variable|function|component)\s+(?:named|called)\b/i.test(item?.question || '')) errors.push('question appears to test identifier trivia');
  return errors;
}

export function architectureQuestionPin(item, input, { policyVersion = 'architecture-learning-policy-v1', authorizationVersion = 'local-auth-v1', correctionVersion = 'none' } = {}) {
  const errors = validateArchitectureLearningItem(item, input);
  if (errors.length) throw new Error(`Cannot pin invalid architecture item: ${errors.join('; ')}`);
  return {
    graph_build_id: input.graph_build_id, revision_vector: input.revision_vector,
    contract_version: input.contract_version, policy_version: policyVersion,
    authorization_version: authorizationVersion, correction_version: correctionVersion,
    claim_ids: [...new Set(item.supporting_claim_ids)].sort(),
  };
}

export function materializeArchitectureEvidence(pack, repositories) {
  const files = new Map();
  const repositoryKeys = new Set();
  const repositoryIds = new Set();
  for (const repository of repositories) {
    if (repositoryIds.has(repository.repository_id)) throw new Error(`Duplicate repository: ${repository.repository_id}`);
    repositoryIds.add(repository.repository_id);
    const repositoryKey = `${repository.repository_id}:${repository.revision}`;
    if (repositoryKeys.has(repositoryKey)) throw new Error(`Duplicate repository snapshot: ${repositoryKey}`);
    repositoryKeys.add(repositoryKey);
    for (const file of repository.files || []) {
      const key = `${repositoryKey}:${file.path}`;
      if (files.has(key)) throw new Error(`Duplicate repository file: ${key}`);
      files.set(key, file);
    }
  }
  const suppliedRefs = new Set((pack.evidence || []).map((ref) => JSON.stringify([
    ref.claimId || ref.claim_id, ref.repoId || ref.repository_id, ref.commitSha || ref.revision,
    ref.path, ref.startLine || ref.line_start, ref.endLine || ref.line_end, ref.contentHash || ref.content_hash,
  ])));
  for (const claim of pack.claims || []) {
    const claimId = claim.id || claim.claim_id;
    for (const ref of claim.evidence || []) {
      const key = JSON.stringify([claimId, ref.repoId || ref.repository_id, ref.commitSha || ref.revision,
        ref.path, ref.startLine || ref.line_start, ref.endLine || ref.line_end, ref.contentHash || ref.content_hash]);
      if (!suppliedRefs.has(key)) throw new Error(`Evidence pack is not closed for claim: ${claimId}`);
    }
  }
  const excerpts = [];
  const fileMaterial = new Map();
  for (const ref of pack.evidence || []) {
    const repositoryId = ref.repoId || ref.repository_id; const revision = ref.commitSha || ref.revision;
    const file = files.get(`${repositoryId}:${revision}:${ref.path}`);
    if (!file || file.complete === false || file.truncated || typeof file.content !== 'string') throw new Error(`Evidence is not materializable: ${repositoryId}:${revision}:${ref.path}`);
    const expectedHash = ref.contentHash || ref.content_hash;
    let material = fileMaterial.get(file);
    if (!material) {
      material = { hash: createHash('sha256').update(file.content).digest('hex'), lines: file.content.split(/\r?\n/) };
      fileMaterial.set(file, material);
    }
    const actualHash = material.hash;
    if (!expectedHash || actualHash !== expectedHash) throw new Error(`Evidence content hash mismatch: ${repositoryId}:${revision}:${ref.path}`);
    const start = Math.max(1, Number(ref.startLine || ref.line_start || 1)); const end = Math.min(start + 20, Number(ref.endLine || ref.line_end || start));
    const excerpt = material.lines.slice(start - 1, end).join('\n').slice(0, 1_000);
    if (!ref.claimId && !ref.claim_id) throw new Error('Evidence reference is missing its claim ID');
    // Empty package markers can prove a structural boundary in the graph, but
    // cannot provide a source quote to the model. Their revision and hash are
    // still validated above before they are omitted from model transport.
    if (!excerpt.trim()) continue;
    excerpts.push({ claim_id: ref.claimId || ref.claim_id, repository_id: repositoryId, revision, path: ref.path, start_line: start, end_line: end, excerpt });
  }
  return excerpts;
}

export function expandArchitectureTransport(transport, input) {
  const supporting_claim_ids = String(transport?.supporting_claim_ids || '').split(',').map((value) => value.trim()).filter(Boolean);
  return {
    scope: input.scope, learning_level: input.learning_level, question_type: transport?.question_type, mental_model_kind: transport?.mental_model_kind,
    mental_model: transport?.mental_model, context: transport?.context, question: transport?.question,
    answer_options: [['A', transport?.answer_a], ['B', transport?.answer_b], ['C', transport?.answer_c]].map(([id, text]) => ({ id, text })),
    correct_option_id: transport?.correct_option_id, explanation: transport?.explanation, supporting_claim_ids,
  };
}

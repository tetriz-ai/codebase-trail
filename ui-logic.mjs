// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
export function formatCoverageCount(value, { exact = false } = {}) {
  const count = BigInt(value ?? 0);
  if (exact) return count.toLocaleString('en-US');
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
    .format(count).replace(/K$/, ' k').replace(/M$/, ' mn').replace(/B$/, ' bn').replace(/T$/, ' tn');
}

export function architectureOutcome(body, scope) {
  if (body?.status === 'abstained') {
    const pack = body.analysis?.scopes?.[scope]?.evidence_pack; const summary = body.evidence_summary;
    return {
      kind: 'abstained',
      title: `No ${String(scope).toUpperCase()} item published`,
      reason: body.reason_code || 'insufficient_verified_architecture_evidence',
      claim_count: summary?.claim_count ?? pack?.claims?.length ?? 0,
      path_count: summary?.path_count ?? pack?.paths?.length ?? 0,
    };
  }
  if (body?.status === 'rejected') {
    return {
      kind: 'rejected',
      title: `Generated ${String(scope).toUpperCase()} item withheld`,
      reason: body.reason_code || 'quality_review_failed',
      stage: body.rejection_stage || body.generation_attempts?.at(-1)?.stage || 'quality_review',
      validation_errors: Array.isArray(body.validation_errors) ? body.validation_errors.slice(0, 10).map(String) : [],
      attempts: Array.isArray(body.generation_attempts) ? body.generation_attempts.length : 0,
    };
  }
  return { kind: 'published' };
}

export function generationRejectionOutcome(body) {
  const stage = body?.rejection_stage || body?.generation_attempts?.at(-1)?.stage || 'quality_review';
  const generationAttempts = new Set((body?.generation_attempts || []).map((attempt) => attempt?.generation_attempt).filter(Number.isInteger)).size;
  const explanations = {
    deterministic_validation: 'The model produced a question, but the latest version failed deterministic grounding or format checks.',
    adversarial_review: 'The question passed deterministic checks, but the quality reviewer rejected the latest version.',
    generation: 'The model did not return a usable structured question.',
    adversarial_review_transport: 'The question could not be approved because the quality reviewer did not return a usable response.',
    structured_output_capability: 'The configured model endpoint did not support the required structured response.',
  };
  const reasonExplanations = {
    local_transport_validation_failed: 'The model returned a structured question, but it failed a local publication rule on both attempts.',
    model_output_truncated: 'The model used its full response allowance, including reasoning, on both attempts. In Settings → Advanced model controls, check Maximum completion and Context window against this model’s published limits, or choose a model with a larger output capacity.',
    model_output_invalid_json: 'The model returned malformed or extra text instead of one JSON object twice.',
    model_output_schema_violation: 'The model response did not match the required fields or limits twice.',
    model_provider_transient: 'The model service was temporarily unavailable during both attempts.',
    model_provider_failure: 'The model service rejected the request.',
    model_provider_http_error: 'The model service rejected the request. Check the model ID, API base URL, credential, and account access in Settings.',
    model_provider_access_restricted: 'This free model is limited to approved agentic harnesses on OpenRouter. Choose a model available to this app in Settings.',
    model_provider_age_confirmation_required: 'OpenRouter requires age confirmation for this model. Complete it in OpenRouter Settings → Preferences, then try again.',
    model_provider_invalid_response: 'The model service returned an incomplete or unreadable response.',
    model_cli_missing: 'The selected model CLI is missing. Open Settings to install it, then select Check again.',
    model_cli_auth_required: 'The selected model CLI needs sign-in. Open Settings for the sign-in command, then select Check again.',
    model_cli_invalid_model: 'The selected CLI does not recognize that model ID. Open Settings and choose a listed alias or enter a full model ID from the provider’s guide.',
    model_cli_failed: 'The selected model CLI did not return an answer. Check its sign-in and model ID in Settings.',
    model_provider_timeout: stage === 'adversarial_review_transport'
      ? 'The quality reviewer exceeded its configured time limit. Choose a faster review model or lower its reasoning effort in Settings.'
      : 'The question model exceeded its configured time limit. Choose a faster model or lower its reasoning effort in Settings.',
    model_transport_timeout_or_cancelled: 'The model call timed out or was cancelled.',
    model_transport_network_failure: 'The application could not reach the model service.',
  };
  return {
    title: 'No question was published',
    explanation: reasonExplanations[body?.reason_code] || explanations[stage] || 'The generated question did not pass every publication check.',
    stage,
    attempts: generationAttempts,
    details: Array.isArray(body?.validation_errors) ? body.validation_errors.slice(0, 3).map(String) : [],
  };
}

export function compactArchitectureEvidence(architecture, item) {
  const selected = new Set(item?.supporting_claim_ids || []);
  return {
    evidence_pin: item?.evidence_pin || null,
    graph_build_id: architecture?.graph_build_id || null,
    revision_vector: architecture?.revision_vector || [],
    supporting_claim_ids: [...selected],
    claim_refs: (architecture?.claims || []).filter((claim) => selected.has(claim.id)).map((claim) => ({
      id: claim.id,
      kind: claim.kind || null,
      provenance: typeof claim.provenance === 'string' ? claim.provenance : claim.provenance?.classification || claim.provenance?.source || null,
      evidence_refs: (claim.evidence || []).map((entry) => ({ repository_id: entry.repoId || entry.repository_id || null, path: entry.path || null })).filter((entry) => entry.repository_id || entry.path),
    })),
    path_refs: (architecture?.paths || []).map((path) => ({ path_id: path.path_id || path.id || null, claim_ids: Array.isArray(path) ? path : path.claim_ids || [] })),
  };
}

function endpointLabel(value) {
  const parts = String(value || '').split('::').filter(Boolean);
  return (parts.at(-1) || 'Unknown endpoint').replaceAll('_', ' ').replaceAll('-', ' ');
}

export function architectureEvidenceView(architecture) {
  const claims = Array.isArray(architecture?.claims) ? architecture.claims : [];
  const references = claims.flatMap((claim) => (claim.evidence || []).map((entry) => ({
    repository_id: entry.repository_id || entry.repoId || 'repository',
    revision: entry.revision || entry.commitSha || '', path: entry.path || '',
    start_line: entry.start_line || entry.startLine || null, end_line: entry.end_line || entry.endLine || null,
  })).filter(({ path }) => path));
  const fileKeys = new Set(references.map((entry) => JSON.stringify([entry.repository_id, entry.revision, entry.path])));
  const revisionKeys = new Set(references.map((entry) => JSON.stringify([entry.repository_id, entry.revision])).filter(Boolean));
  const relationships = claims.map((claim, index) => {
    const source = endpointLabel(claim.sourceId || claim.source_id || claim.from);
    const target = endpointLabel(claim.targetId || claim.target_id || claim.to);
    const seen = new Set(); const files = [];
    for (const entry of (claim.evidence || [])) {
      const repository = entry.repository_id || entry.repoId || 'repository'; const revision = entry.revision || entry.commitSha || '';
      const path = entry.path || ''; const start = entry.start_line || entry.startLine; const end = entry.end_line || entry.endLine;
      const key = JSON.stringify([repository, revision, path, start, end]); if (!path || seen.has(key)) continue;
      seen.add(key); const lines = start ? `:${start}${end && end !== start ? `–${end}` : ''}` : '';
      files.push({ repository, path, start_line: start || null, end_line: end || null, label: `${repository} · ${path}${lines}` });
    }
    const sourceLocation = files[0] ? `${files[0].path}${files[0].start_line ? `:${files[0].start_line}` : ''}` : null;
    const label = source === target && sourceLocation ? `Relationship declared at ${sourceLocation}` : source === 'Unknown endpoint' || target === 'Unknown endpoint' ? `Relationship ${index + 1}` : `${source} → ${target}`;
    return { label, kind: String(claim.kind || 'source relationship').replaceAll('_', ' '), files: files.slice(0, 3) };
  });
  const revisionCount = revisionKeys.size || (architecture?.revision_vector && typeof architecture.revision_vector === 'object' ? (Array.isArray(architecture.revision_vector) ? architecture.revision_vector.length : Object.keys(architecture.revision_vector).length) : 0);
  const displayedRevisionCount = revisionCount || 1;
  return {
    file_count: fileKeys.size, revision_count: revisionCount, relationships,
    path_count: Array.isArray(architecture?.paths) ? architecture.paths.length : 0,
    revision_copy: `Checked against source files from ${displayedRevisionCount} pinned repository revision${displayedRevisionCount === 1 ? '' : 's'}.`,
  };
}

export function learnerSafeHistoryText(value, { architecture = false, legacy = false } = {}) {
  const text = String(value || '');
  if (!architecture) return text;
  const legacyCitation = /\(\s*C[1-9]\d*(?:\s*,\s*C[1-9]\d*)*\s*\)/i;
  const legacyMachinery = /\b(?:the\s+)?(?:graph|evidence|claims?)\s+(?:shows?|says?|proves?|indicates?)\b/i;
  if (!legacy && !legacyCitation.test(text) && !legacyMachinery.test(text)) return text;
  return text
    .replace(/\s*\(\s*C[1-9]\d*(?:\s*,\s*C[1-9]\d*)*\s*\)/gi, '')
    .replace(/\b(?:the\s+)?(?:graph|evidence|claims?)\s+(?:shows?|says?|proves?|indicates?)\b/gi, 'The code establishes')
    .replace(/\bC[1-9]\d*\b/gi, 'the cited relationship')
    .replace(/\s{2,}/g, ' ').trim();
}

export function storeFeedback(storage, key, records) {
  try {
    storage.setItem(key, JSON.stringify(records));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.name === 'QuotaExceededError' ? 'storage_quota_exceeded' : 'storage_write_failed' };
  }
}

export function timingEntries(body) {
  const raw = body?.timings || body?.telemetry?.timings || body?.telemetry?.stages || body?.metrics?.timings;
  if (!raw) return [];
  const values = Array.isArray(raw)
    ? raw.map((entry) => [entry?.stage || entry?.name, entry?.duration_ms ?? entry?.elapsed_ms ?? entry?.ms])
    : Object.entries(raw).map(([name, value]) => [name, typeof value === 'object' ? value?.duration_ms ?? value?.elapsed_ms ?? value?.ms : value]);
  return values
    .map(([name, milliseconds]) => ({ name: String(name || '').replaceAll('_', ' '), milliseconds: Number(milliseconds) }))
    .filter((entry) => entry.name && Number.isFinite(entry.milliseconds) && entry.milliseconds >= 0);
}

export function timingSummary(body) {
  const entries = timingEntries(body);
  if (!entries.length) return '';
  return entries.map(({ name, milliseconds }) => `${name} ${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`).join(' · ');
}

export function recordIdentity(record) {
  if (record?.record_id) return String(record.record_id);
  const scope = record?.source_scope || 'pr';
  const source = record?.source_pr?.number ?? record?.evidence?.graph_build_id ?? 'unknown';
  const question = record?.generation?.question?.question?.text ?? record?.generation?.question?.question ?? '';
  return `${scope}:${source}:${String(question).trim().toLowerCase()}`;
}

export function mergeHistoryRecords(current, incoming) {
  const records = new Map();
  for (const record of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!record || typeof record !== 'object') continue;
    const identity = recordIdentity(record);
    const previous = records.get(identity);
    const previousTime = Date.parse(previous?.saved_at || previous?.generated_at || 0) || 0;
    const nextTime = Date.parse(record.saved_at || record.generated_at || 0) || 0;
    if (!previous || nextTime >= previousTime) records.set(identity, record);
  }
  return [...records.values()].sort((left, right) => {
    const leftTime = Date.parse(left.saved_at || left.generated_at || 0) || 0;
    const rightTime = Date.parse(right.saved_at || right.generated_at || 0) || 0;
    return rightTime - leftTime;
  });
}

export function parseHistoryImport(value) {
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { return { ok: false, reason: 'invalid_json', records: [] }; }
  const candidates = Array.isArray(parsed) ? parsed : parsed?.records;
  if (!Array.isArray(candidates)) return { ok: false, reason: 'records_missing', records: [] };
  const records = candidates.flatMap((record) => {
    if (!record || typeof record !== 'object') return [];
    if (record.record_id || record.generation?.question) return [record];
    if (!record.id || typeof record.question !== 'string') return [];
    return [{ record_version: 'codebase-trail-feedback-v2', record_id: record.id, saved_at: record.updated_at, source_scope: record.metadata?.scope || 'architecture', source_pr: record.metadata?.source_pr || null, generation: { model: record.metadata?.model || null, question: { question: { text: record.question }, answer_options: record.choices || [], correct_option_id: record.answer || null, evidence_pin: record.evidence_pin } }, learner_answer: record.first_attempt ? { selected_option_id: record.first_attempt.selected_option_id || record.first_attempt.selected || null, was_correct: record.first_attempt.was_correct ?? record.first_attempt.correct ?? null } : {}, feedback: record.first_attempt?.feedback || {} }];
  });
  if (!records.length && candidates.length) return { ok: false, reason: 'records_invalid', records: [] };
  return { ok: true, records, rejected_count: candidates.length - records.length };
}

export function historyView(records) {
  const unique = mergeHistoryRecords([], records);
  return unique.map((record) => {
    const item = record.generation?.question || {};
    const question = item.question?.text || item.question || 'Untitled learning item';
    const source = record.source_pr?.number ? `PR #${record.source_pr.number}` : String(record.source_scope || 'Architecture').toUpperCase();
    const status = record.learner_answer?.was_correct === true ? 'Correct' : record.learner_answer?.was_correct === false ? 'Review' : 'Revealed';
    return { id: recordIdentity(record), question, source, status, saved_at: record.saved_at || record.generated_at || null };
  });
}

export function runtimeStatus(body) {
  const providerLabel = (entry, fallbackProvider, fallbackModel) => {
    const provider = entry?.name || (typeof entry === 'string' ? entry : null) || fallbackProvider;
    const model = entry?.model || fallbackModel;
    return model ? `${provider} · ${model}` : String(provider);
  };
  const legacyProvider = body?.provider?.name || body?.provider || 'Configured model';
  const legacyModel = body?.provider?.model || body?.model || null;
  const generator = providerLabel(body?.model_provider, legacyProvider, legacyModel);
  const reviewer = body?.reviewer_provider
    ? providerLabel(body.reviewer_provider, 'Configured reviewer', null)
    : 'Same as question generator';
  const local = body?.privacy?.execution === 'local' || body?.local === true;
  const egress = body?.privacy?.source_egress === false ? 'Source stays local' : body?.privacy?.source_egress === true ? 'Source may leave this device' : 'Check provider data policy';
  return { provider: generator, generator, reviewer, privacy: local ? `Local runtime · ${egress}` : egress, available: body?.status !== 'unavailable' };
}

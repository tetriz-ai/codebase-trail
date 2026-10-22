// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export function createReproducibilityManifest({ repositories = [], provider, model, model_settings = {}, extractor_manifest = [], prompt_contract, evidence_policy = {}, generation_contract = 'quiz-generation-v1' } = {}) {
  const revision_vector = Object.fromEntries(repositories.map(({ repository_id, revision }) => [repository_id, revision]).filter(([id, revision]) => id && revision));
  return Object.freeze({
    contract_version: 'quiz-reproducibility-v2',
    generation_contract,
    revision_vector: Object.freeze(revision_vector),
    provider: provider || null,
    model: model || null,
    model_settings: Object.freeze({
      temperature: model_settings.temperature ?? null,
      max_tokens: model_settings.max_tokens ?? null,
      retry_max_tokens: model_settings.retry_max_tokens ?? null,
      resolved_max_tokens: model_settings.resolved_max_tokens ?? null,
      structured_output: model_settings.structured_output ?? null,
      token_parameter: model_settings.token_parameter ?? null,
      system_instruction_mode: model_settings.system_instruction_mode ?? null,
      auth_mode: model_settings.auth_mode ?? null,
      reasoning_mode: model_settings.reasoning_mode ?? null,
      reasoning_effort: model_settings.reasoning_effort ?? null,
      temperature_included: model_settings.temperature_included ?? null,
      review_provider: model_settings.review_provider ?? null,
      review_model: model_settings.review_model ?? null,
      review_auth_mode: model_settings.review_auth_mode ?? null,
      review_structured_output: model_settings.review_structured_output ?? null,
      review_token_parameter: model_settings.review_token_parameter ?? null,
      review_system_instruction_mode: model_settings.review_system_instruction_mode ?? null,
      review_reasoning_mode: model_settings.review_reasoning_mode ?? null,
      review_reasoning_effort: model_settings.review_reasoning_effort ?? null,
      review_temperature_included: model_settings.review_temperature_included ?? null,
      review_temperature: model_settings.review_temperature ?? null,
      review_max_tokens: Object.freeze([...(model_settings.review_max_tokens || [])]),
      resolved_review_max_tokens: model_settings.resolved_review_max_tokens ?? null,
    }),
    extractor_manifest: Object.freeze(extractor_manifest.map(({ id, version, api_version }) => ({ id, version, api_version }))),
    prompt_contract: prompt_contract || null,
    evidence_policy_hash: digest(evidence_policy),
  });
}

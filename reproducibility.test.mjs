// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReproducibilityManifest } from './reproducibility.mjs';

test('creates a deterministic, source-free reproducibility manifest', () => {
  const input = { repositories: [{ repository_id: 'acme/api', revision: 'abc' }], provider: 'openai-compatible', model: 'm', model_settings: { temperature: 0.2, temperature_included: false, max_tokens: 100, retry_max_tokens: 200, resolved_max_tokens: 88, token_parameter: 'max_completion_tokens', system_instruction_mode: 'developer', reasoning_mode: 'openai', reasoning_effort: 'low', review_provider: 'openai-compatible', review_model: 'review-m', resolved_review_max_tokens: 77, review_structured_output: 'json_object', review_token_parameter: 'max_tokens', review_system_instruction_mode: 'user-prefix', review_reasoning_mode: 'openrouter', review_reasoning_effort: 'medium', review_temperature_included: true }, extractor_manifest: [{ id: 'go', version: '2', api_version: '1.0', extract() {} }], prompt_contract: 'quiz-v2', evidence_policy: { max: 8 } };
  const first = createReproducibilityManifest(input);
  const second = createReproducibilityManifest(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.revision_vector, { 'acme/api': 'abc' });
  assert.equal(first.extractor_manifest[0].extract, undefined);
  assert.equal(first.model_settings.retry_max_tokens, 200);
  assert.equal(first.model_settings.reasoning_effort, 'low');
  assert.equal(first.model_settings.temperature_included, false);
  assert.equal(first.model_settings.resolved_max_tokens, 88);
  assert.equal(first.model_settings.token_parameter, 'max_completion_tokens');
  assert.equal(first.model_settings.review_model, 'review-m');
  assert.equal(first.model_settings.review_structured_output, 'json_object');
  assert.equal(first.model_settings.review_token_parameter, 'max_tokens');
  assert.equal(first.model_settings.review_temperature_included, true);
  assert.equal(first.model_settings.review_reasoning_mode, 'openrouter');
  assert.match(first.evidence_policy_hash, /^[a-f0-9]{64}$/);
  assert.equal(createReproducibilityManifest({ evidence_policy: { a: 1, b: 2 } }).evidence_policy_hash, createReproducibilityManifest({ evidence_policy: { b: 2, a: 1 } }).evidence_policy_hash);
});

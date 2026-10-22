// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphBuild, generateArchitectureLearningItem, generateLearningItem, initialTokenBudget, generationRetryTokenBudget, reviewRetryTokenBudget, persistedArchitectureQuestion, restoreArchitectureQuestion } from './server.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentRevisionCache } from './persistent-cache.mjs';

const reviewPass = { decision: 'pass', critique: 'No blocking issues.', answer_key_consistent: true, exactly_one_defensible: true, mental_model_transferable: true, avoids_identifier_trivia: true, scenario_distinct: true, evidence_grounded: true, learner_prose_concise: true };

const repositories = {
  lld: [{ repository_id: 'fixture-lld', revision: 'abc', tree_complete: true, files: [
    { path: 'package.json', content: '{"name":"fixture-lld"}', complete: true },
    { path: 'src/a.js', content: 'import b from "./b.js"; export default b;\n', complete: true },
    { path: 'src/b.js', content: 'export default 1;\n', complete: true },
  ] }],
  service: [{ repository_id: 'fixture-services', revision: 'def', tree_complete: true, files: [
    { path: 'docker-compose.yml', content: 'services:\n  api:\n    image: api\n    depends_on:\n      - worker\n  worker:\n    image: worker\n', complete: true },
  ] }],
  hld: [{ repository_id: 'fixture-hld', revision: 'ghi', tree_complete: true, files: [
    { path: 'docker-compose.yml', content: 'services:\n  api:\n    image: api\n    depends_on:\n      - worker\n  worker:\n    image: worker\n    depends_on:\n      - db\n  db:\n    image: postgres\n', complete: true },
  ] }],
};

function architectureTransport(scope, aliases, explanation = 'The dependency crosses the selected boundary. The caller must account for that relationship.') {
  const shapes = {
    lld: ['component_role', 'responsibility'],
    service: ['service_dependency', 'dependency'],
    hld: ['system_flow', 'multi_service_flow'],
  };
  return {
    question_type: shapes[scope][0], mental_model_kind: shapes[scope][1], mental_model: 'Dependencies define a change boundary.',
    context: 'A caller depends on another source-backed component.', question: 'Which outcome follows from this dependency?',
    answer_a: 'The caller can be affected by a dependency change.', answer_b: 'Every unrelated component must change.', answer_c: 'The dependency ceases to exist.',
    correct_option_id: 'A', explanation, supporting_claim_ids: aliases.join(','),
  };
}

function architectureCompletion(scope, { firstGeneration, reviews = [reviewPass] } = {}) {
  let generations = 0; let reviewIndex = 0;
  return async (_system, user, _schema, name) => {
    if (name === 'architecture_learning_adversarial_review_v1') return { value: reviews[Math.min(reviewIndex++, reviews.length - 1)], model: 'fake-reviewer', usage: { totalTokens: 3 }, reasoningRequestMode: 'openrouter', temperatureIncluded: true };
    const input = JSON.parse(user.match(/<UNTRUSTED_INPUT>\n([\s\S]+)\n<\/UNTRUSTED_INPUT>/)[1]).input;
    generations += 1;
    const aliases = scope === 'hld' ? input.paths[0] : [input.claims[0].claim_id];
    return { value: generations === 1 && firstGeneration ? firstGeneration(aliases) : architectureTransport(scope, aliases), model: 'fake-generator', usage: { totalTokens: 5 }, reasoningRequestMode: 'openai', temperatureIncluded: false };
  };
}

for (const scope of ['lld', 'service', 'hld']) test(`publishes and persists a complete ${scope.toUpperCase()} item through generation, review, pinning, and evidence projection`, async (t) => {
  const result = await generateArchitectureLearningItem({ scope, repositories: repositories[scope], max_hld_hops: 4 }, { complete_json: architectureCompletion(scope) });
  assert.equal(result.status, 'published');
  assert.equal(result.item.scope, scope);
  assert.ok(result.item.supporting_claim_ids.every((id) => id.startsWith('claim:')));
  assert.doesNotMatch(JSON.stringify(result.item), /__CLAIM_/i);
  assert.ok(result.architecture.claims.length >= 1);
  assert.equal(result.model, 'fake-generator');
  assert.equal(result.review_model, 'fake-reviewer');
  assert.equal(result.usage.totalTokens, 5);
  assert.equal(result.usage_totals.generation.totalTokens, 5);
  assert.equal(result.usage_totals.review.totalTokens, 3);
  assert.equal(result.reproducibility.model_settings.reasoning_mode, 'openai');
  assert.equal(result.reproducibility.model_settings.temperature_included, false);
  assert.equal(result.reproducibility.model_settings.review_reasoning_mode, 'openrouter');
  assert.equal(result.reproducibility.model_settings.review_temperature_included, true);
  assert.ok(result.architecture.claims.every((claim) => claim.evidence.length && claim.evidence.every((entry) => entry.path && !('excerpt' in entry))));
  if (scope === 'hld') assert.ok(result.architecture.paths.some((path) => path.length >= 2));
  // Exercise the real cache security boundary with production-shaped metadata.
  const directory = await mkdtemp(join(tmpdir(), 'architecture-published-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, name: 'published', toPersistedValue: persistedArchitectureQuestion };
  await new PersistentRevisionCache(options).set(result.graph_build_id, { scope }, result);
  const disk = JSON.parse(await readFile(join(directory, 'published.json'), 'utf8'));
  assert.equal(disk.entries[0].value.reproducibility.template_contract, result.reproducibility.prompt_contract);
  assert.equal(disk.entries[0].value.reproducibility.policy_hash, result.reproducibility.evidence_policy_hash);
  assert.ok(!('prompt_contract' in disk.entries[0].value.reproducibility));
  const restored = restoreArchitectureQuestion(await new PersistentRevisionCache(options).get(result.graph_build_id, { scope }));
  assert.deepEqual(restored.reproducibility, result.reproducibility);
  assert.deepEqual(restored.item, result.item);
  assert.ok(restored.architecture.claims.every((claim) => claim.evidence.every((ref) => !('excerpt' in ref))));
});

test('architecture generation rejects a previously answered question instead of publishing the cached wording', async () => {
  const prior = 'Which outcome follows from this dependency?';
  const result = await generateArchitectureLearningItem({ scope: 'lld', repositories: repositories.lld, prior_questions: [prior] }, { complete_json: architectureCompletion('lld') });
  assert.equal(result.status, 'rejected');
  assert.ok(result.validation_errors.some((error) => error.includes('previously answered')));
});

test('architecture orchestration revises deterministic failures and withholds repeated invalid output', async () => {
  const invalid = (aliases) => architectureTransport('lld', aliases, 'The graph shows __CLAIM_1__. It proves the answer.');
  const recovered = await generateArchitectureLearningItem({ scope: 'lld', repositories: repositories.lld }, { complete_json: architectureCompletion('lld', { firstGeneration: invalid }) });
  assert.equal(recovered.status, 'published');
  assert.ok(recovered.generation_attempts.some(({ stage, decision }) => stage === 'deterministic_validation' && decision === 'revise'));
  const alwaysInvalid = async (_system, user, _schema, name) => {
    if (name === 'architecture_learning_adversarial_review_v1') return { value: reviewPass };
    const input = JSON.parse(user.match(/<UNTRUSTED_INPUT>\n([\s\S]+)\n<\/UNTRUSTED_INPUT>/)[1]).input;
    return { value: invalid([input.claims[0].claim_id]) };
  };
  const rejected = await generateArchitectureLearningItem({ scope: 'lld', repositories: repositories.lld }, { complete_json: alwaysInvalid });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.generation_attempts.at(-1).stage, 'deterministic_validation');
  assert.equal(rejected.reason_code, 'not_approved_after_two_generation_attempts');
});

test('architecture orchestration revises reviewer failures and abstains before model calls when evidence is unavailable', async () => {
  const revise = { ...reviewPass, decision: 'revise', critique: 'Use a clearer scenario.', mental_model_transferable: false };
  const revised = await generateArchitectureLearningItem({ scope: 'service', repositories: repositories.service }, { complete_json: architectureCompletion('service', { reviews: [revise, reviewPass] }) });
  assert.equal(revised.status, 'published');
  assert.equal(revised.generation_attempts.filter(({ stage }) => stage === 'adversarial_review').length, 2);
  let calls = 0;
  const abstained = await generateArchitectureLearningItem({ scope: 'hld', repositories: repositories.service }, { complete_json: async () => { calls += 1; } });
  assert.equal(abstained.status, 'abstained');
  assert.equal(calls, 0);
});

function prBundle() {
  const revision = 'a'.repeat(40); const quote = 'The request crosses an explicit service boundary.';
  return {
    contract_version: 'v2', policy_version: 'test', authorization_version: 'test', correction_version: 'none', allowed_question_types: ['mental_model'],
    contribution_context: { title: 'Add boundary handling' }, architecture_map: { completeness: 'complete', components: [], relationships: [] },
    graph_build: createGraphBuild({ organization_id: 'test', repositories: [{ repository_id: 'fixture/pr', revision, tree_complete: true, required_blobs_complete: true }] }),
    retrieval: { repository_revision_indexed: true, repository_tree_truncated: false },
    evidence_bundle: { bundle_id: 'fixture-pr-1', organization_id: 'test', repository_id: 'fixture/pr', repository_revision: revision, source_pr: { number: 1, title: 'Add boundary handling', url: 'https://example.test/pr/1', relation: 'own' }, sources: [{ source_id: 'source_1', kind: 'source_file', path_or_url: 'src/api.js', revision, content: quote }] },
    repetition_context: { review_stage: 'first_exposure', recent_questions: [], recent_contexts: [], recent_question_types: [], recent_question_formats: [], recent_mental_models: [] }, exclusions: [],
  };
}

function prTransport() {
  return {
    question_type: 'mental_model', question_format: 'scenario_prediction', mental_model: 'A service boundary contains dependency failures.', context: 'An API calls another service.', immediate_work_payoff: 'Recognize where failures must be handled.',
    question: 'Where should the dependency failure be handled?', answer_a: 'At the calling boundary.', answer_b: 'By deleting the dependency.', answer_c: 'By changing an unrelated service.', correct_option_id: 'A',
    key_concepts: 'service boundary|failure handling', explanation: 'The caller owns handling the dependency failure.', answer_analysis: 'A is uniquely correct because the caller owns the boundary. B fails because deletion is unsupported. C fails because the unrelated service is outside the flow.',
    supporting_source_ids: 'source_1', evidence_quotes: 'source_1::The request crosses an explicit service boundary.', architecture_ref: 'none',
  };
}

test('publishes and pins a PR question through the complete generation and review path', async () => {
  const complete = async (_system, _user, _schema, name) => name === 'code_learning_adversarial_review_v1'
    ? { value: reviewPass, model: 'fake-reviewer', usage: { totalTokens: 3 }, reasoningRequestMode: 'openrouter', temperatureIncluded: false }
    : { value: prTransport(), model: 'fake-generator', usage: { totalTokens: 5 }, reasoningRequestMode: 'openai', temperatureIncluded: true };
  const result = await generateLearningItem(1, 'applied', 'first_exposure', true, [], undefined, { build_evidence_bundle: async () => prBundle(), complete_json: complete });
  assert.equal(result.status, 'published', JSON.stringify(result, null, 2));
  assert.equal(result.output.item.evidence_pin.repository_revision, 'a'.repeat(40));
  assert.deepEqual(result.output.item.evidence_pin.sources.map(({ source_id }) => source_id), ['source_1']);
  assert.equal(result.model, 'fake-generator');
  assert.equal(result.review_model, 'fake-reviewer');
  assert.equal(result.usage.totalTokens, 5);
  assert.deepEqual(result.usage_totals, {
    generation: { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedInputTokens: null, totalTokens: 5 },
    review: { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedInputTokens: null, totalTokens: 3 },
  });
  assert.equal(result.reproducibility.model_settings.reasoning_mode, 'openai');
  assert.equal(result.reproducibility.model_settings.temperature_included, true);
  assert.equal(result.reproducibility.model_settings.review_reasoning_mode, 'openrouter');
  assert.equal(result.reproducibility.model_settings.review_temperature_included, false);
});
test('PR review sees bounded source context and a revision sees the candidate it must repair', async () => {
  const generationPrompts = []; const reviews = [];
  const complete = async (_system, user, _schema, name) => {
    if (name === 'code_learning_adversarial_review_v1') {
      reviews.push(JSON.parse(user.match(/<UNTRUSTED_REVIEW_INPUT>\n([\s\S]+)\n<\/UNTRUSTED_REVIEW_INPUT>/)[1]));
      return { value: reviews.length === 1 ? { ...reviewPass, decision: 'revise', critique: 'Explain the dependency boundary more clearly.', mental_model_transferable: false } : reviewPass };
    }
    generationPrompts.push(user);
    return { value: prTransport() };
  };
  const bundle = { ...prBundle(), evidence_bundle: { ...prBundle().evidence_bundle, bundle_id: 'fixture-pr-review-context' } };
  const result = await generateLearningItem(1, 'applied', 'intentional_review', true, [], undefined, { build_evidence_bundle: async () => bundle, complete_json: complete });
  assert.equal(result.status, 'published');
  assert.ok(result.model_input_chars > 0);
  assert.equal(result.timings.model_input_chars, undefined);
  assert.equal(generationPrompts.length, 2);
  const modelInput = JSON.parse(generationPrompts[0].match(/<UNTRUSTED_INPUT>\n([\s\S]+)\n<\/UNTRUSTED_INPUT>/)[1]);
  assert.equal(modelInput.graph_build, undefined);
  assert.equal(modelInput.evidence_bundle.sources[0].content, bundle.evidence_bundle.sources[0].content);
  assert.match(generationPrompts[1], /Prior candidate:/);
  assert.match(generationPrompts[1], /Explain the dependency boundary more clearly/);
  assert.equal(reviews[0].source_context[0].excerpt, bundle.evidence_bundle.sources[0].content);
  assert.equal(reviews[0].source_pr.title, bundle.evidence_bundle.source_pr.title);
});

test('local transport errors give the next PR attempt its failed candidate and exact critique', async () => {
  const prompts = [];
  const complete = async (_system, user, _schema, name) => {
    if (name === 'code_learning_adversarial_review_v1') return { value: reviewPass };
    prompts.push(user);
    return { value: prompts.length === 1 ? { ...prTransport(), question: 'What was the PR number?', evidence_quotes: 'source_1::The request travels across the service boundary.' } : { ...prTransport(), evidence_quotes: 'source_1::@q1' } };
  };
  const fixture = prBundle();
  fixture.evidence_bundle.bundle_id = 'fixture-local-transport-retry';
  const result = await generateLearningItem(1, 'applied', 'first_exposure', true, [], undefined, { build_evidence_bundle: async () => fixture, complete_json: complete });
  assert.equal(result.status, 'published');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /PR-number recall/);
  assert.match(prompts[1], /evidence quote for source_1/);
  assert.match(prompts[1], /Prior candidate:/);
  assert.equal(result.generation_attempts[0].reason_code, 'local_transport_validation_failed');
  assert.equal(result.output.item.evidence_quotes[0].quote, 'The request crosses an explicit service boundary.');
});

test('answered PR question cannot be served from pending cache or republished', async () => {
  const fixture = prBundle();
  fixture.evidence_bundle.bundle_id = 'fixture-pr-repeat-cache';
  let generations = 0;
  const complete = async (_system, _user, _schema, name) => {
    if (name === 'code_learning_adversarial_review_v1') return { value: reviewPass };
    generations += 1;
    return { value: prTransport() };
  };
  const acquire = async (_number, _stage, _focus, priorQuestions) => ({
    ...fixture,
    repetition_context: { ...fixture.repetition_context, recent_questions: priorQuestions.map(({ question }) => question) },
  });
  const first = await generateLearningItem(1, 'applied', 'first_exposure', true, [], undefined, { build_evidence_bundle: acquire, complete_json: complete });
  assert.equal(first.status, 'published');
  const pending = await generateLearningItem(1, 'applied', 'first_exposure', true, [], undefined, { build_evidence_bundle: acquire, complete_json: complete });
  assert.equal(pending.cached, true);
  const answered = await generateLearningItem(1, 'applied', 'first_exposure', true, [{ pr_number: 1, question: first.output.item.question.text }], undefined, { build_evidence_bundle: acquire, complete_json: complete });
  assert.equal(answered.status, 'rejected');
  assert.equal(generations, 3);
  assert.ok(answered.validation_errors.some((error) => error.includes('previously answered')));
});

test('PR orchestration retries malformed candidates and fails closed when review never approves', async () => {
  let generation = 0;
  const retrying = async (_system, _user, _schema, name) => {
    if (name === 'code_learning_adversarial_review_v1') return { value: reviewPass };
    generation += 1;
    return { value: generation === 1 ? { ...prTransport(), answer_b: prTransport().answer_a } : prTransport() };
  };
  const recovered = await generateLearningItem(2, 'applied', 'first_exposure', true, [], undefined, { build_evidence_bundle: async () => ({ ...prBundle(), evidence_bundle: { ...prBundle().evidence_bundle, bundle_id: 'fixture-pr-2', source_pr: { ...prBundle().evidence_bundle.source_pr, number: 2 } } }), complete_json: retrying });
  assert.equal(recovered.status, 'published', JSON.stringify(recovered, null, 2));
  assert.equal(generation, 2);
  const revise = { ...reviewPass, decision: 'revise', critique: 'Not sufficiently transferable.', mental_model_transferable: false };
  const rejected = await generateLearningItem(3, 'applied', 'intentional_review', true, [], undefined, { build_evidence_bundle: async () => ({ ...prBundle(), evidence_bundle: { ...prBundle().evidence_bundle, bundle_id: 'fixture-pr-3', source_pr: { ...prBundle().evidence_bundle.source_pr, number: 3 } } }), complete_json: async (_system, _user, _schema, name) => ({ value: name === 'code_learning_adversarial_review_v1' ? revise : prTransport() }) });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason_code, 'not_approved_after_two_generation_attempts');
});

test('terminal schema failures retain resolved request semantics in the rejected manifest', async () => {
  const execution = { structuredOutputMode: 'json_object', tokenParameter: 'max_completion_tokens', reasoningRequestMode: 'openrouter', temperatureIncluded: false, budget: { maxTokens: 777, estimatedPromptTokens: 100, contextWindowTokens: 8_000, maxCompletionTokens: 1_000 } };
  const complete = async () => { throw Object.assign(new Error('schema mismatch'), { code: 'model_output_schema_violation', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, execution }); };
  const result = await generateLearningItem(5, 'applied', 'intentional_review', true, [], undefined, {
    build_evidence_bundle: async () => ({ ...prBundle(), evidence_bundle: { ...prBundle().evidence_bundle, bundle_id: 'fixture-pr-5', source_pr: { ...prBundle().evidence_bundle.source_pr, number: 5 } } }),
    complete_json: complete,
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason_code, 'model_output_schema_violation');
  assert.equal(result.reproducibility.model_settings.structured_output, 'json_object');
  assert.equal(result.reproducibility.model_settings.token_parameter, 'max_completion_tokens');
  assert.equal(result.reproducibility.model_settings.reasoning_mode, 'openrouter');
  assert.equal(result.reproducibility.model_settings.temperature_included, false);
  assert.equal(result.reproducibility.model_settings.resolved_max_tokens, 777);
  assert.equal(result.usage_totals.generation.totalTokens, 28);
});

test('generation retries receive a larger completion budget in PR and architecture modes', async () => {
  const prBudgets = []; let prGenerations = 0;
  const prComplete = async (_system, _user, _schema, name, _temperature, _timeout, maxTokens) => {
    if (name === 'code_learning_adversarial_review_v1') return { value: reviewPass };
    prBudgets.push(maxTokens); prGenerations += 1;
    if (prGenerations === 1) throw Object.assign(new Error('truncated'), { code: 'model_output_truncated' });
    return { value: prTransport(), model: 'fixture', usage: {} };
  };
  const prResult = await generateLearningItem(4, 'applied', 'first_exposure', true, [], undefined, {
    build_evidence_bundle: async () => ({ ...prBundle(), evidence_bundle: { ...prBundle().evidence_bundle, bundle_id: 'fixture-pr-4', source_pr: { ...prBundle().evidence_bundle.source_pr, number: 4 } } }),
    complete_json: prComplete,
  });
  assert.equal(prResult.status, 'published');
  assert.equal(prBudgets.length, 2);
  assert.ok(prBudgets[1] > prBudgets[0]);

  const architectureBudgets = []; let architectureGenerations = 0;
  const architectureComplete = async (_system, user, _schema, name, _temperature, _timeout, maxTokens) => {
    if (name === 'architecture_learning_adversarial_review_v1') return { value: reviewPass };
    architectureBudgets.push(maxTokens); architectureGenerations += 1;
    if (architectureGenerations === 1) throw Object.assign(new Error('truncated'), { code: 'model_output_truncated' });
    const input = JSON.parse(user.match(/<UNTRUSTED_INPUT>\n([\s\S]+)\n<\/UNTRUSTED_INPUT>/)[1]).input;
    return { value: architectureTransport('lld', [input.claims[0].claim_id]) };
  };
  const architectureResult = await generateArchitectureLearningItem({ scope: 'lld', repositories: repositories.lld }, { complete_json: architectureComplete });
  assert.equal(architectureResult.status, 'published');
  assert.equal(architectureBudgets.length, 2);
  assert.ok(architectureBudgets[1] > architectureBudgets[0]);
});

test('PR generation expands a truncated retry beyond a saved low allowance but respects it for other failures', async () => {
  assert.equal(initialTokenBudget(1_024), 4_096);
  assert.equal(initialTokenBudget(512, 'review'), 2_048);
  assert.equal(initialTokenBudget(8_192), 8_192);
  assert.equal(generationRetryTokenBudget(1_536, { code: 'model_output_truncated' }), 8_192);
  assert.equal(generationRetryTokenBudget(8_192, { code: 'model_output_truncated' }), 8_192);
  assert.equal(generationRetryTokenBudget(1_536, { code: 'model_output_invalid_json' }), 1_536);
  assert.equal(reviewRetryTokenBudget(768, { code: 'model_output_truncated' }), 4_096);
  assert.equal(reviewRetryTokenBudget(768, { code: 'model_output_invalid_json' }), 768);
  const budgets = [];
  const complete = async (_system, _user, _schema, name, _temperature, _timeout, maxTokens) => {
    if (name === 'code_learning_adversarial_review_v1') return { value: reviewPass };
    budgets.push(maxTokens);
    if (budgets.length === 1) throw Object.assign(new Error('truncated'), { code: 'model_output_truncated', usage: { outputTokens: maxTokens, reasoningTokens: maxTokens } });
    return { value: prTransport() };
  };
  const fixture = prBundle(); fixture.evidence_bundle.bundle_id = 'fixture-pr-truncation-floor';
  const result = await generateLearningItem(1, 'applied', 'intentional_review', true, [], undefined, { build_evidence_bundle: async () => fixture, complete_json: complete });
  assert.equal(result.status, 'published');
  assert.equal(budgets.length, 2);
  assert.equal(budgets[1], generationRetryTokenBudget(budgets[1], { code: 'model_output_truncated' }));
  assert.ok(budgets[0] >= 4_096);
  assert.ok(budgets[1] >= 8_192);
});

test('architecture retries retain the same connected sample from a disconnected evidence universe', async () => {
  const files = [{ path: 'package.json', content: '{"name":"connected-fixture"}', complete: true }];
  for (const group of ['left', 'right']) for (let index = 0; index < 4; index += 1) {
    files.push({ path: `${group}/part-${index}/index.js`, content: index < 3 ? `import next from '../part-${index + 1}/index.js'; export default next;` : 'export default 1;', complete: true });
  }
  const inputs = [];
  const completion = architectureCompletion('lld', { firstGeneration: (aliases) => architectureTransport('lld', aliases, 'The graph shows __CLAIM_1__. It proves the answer.') });
  const result = await generateArchitectureLearningItem({ scope: 'lld', repositories: [{ repository_id: 'connected-fixture', revision: 'abc', tree_complete: true, files }] }, {
    complete_json: async (...args) => {
      if (args[3] === 'architecture_lld_learning_v1') inputs.push(JSON.parse(args[1].match(/<UNTRUSTED_INPUT>\n([\s\S]+)\n<\/UNTRUSTED_INPUT>/)[1]).input);
      return completion(...args);
    },
  });
  assert.equal(result.status, 'published');
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], inputs[1]);
  assert.equal(inputs[0].claims.length, 3);
  const group = inputs[0].claims[0].from.includes('left/') ? 'left/' : 'right/';
  assert.ok(inputs[0].claims.every((claim) => claim.from.includes(group) && claim.to.includes(group)));
});

test('feedback ratings and notes do not steer fixed evidence or model generation policy', async () => {
  const payload = { scope: 'lld', repositories: repositories.lld, learning_level: 'systems', prior_questions: ['Which component owns the dependency?'] };
  const requests = [];
  const results = [];
  for (const feedback of [{ difficulty: 1, quality: 1, subjective: 'Too difficult' }, { difficulty: 5, quality: 5, subjective: 'Useful practice' }]) {
    const calls = []; const complete = architectureCompletion('lld');
    results.push(await generateArchitectureLearningItem({ ...payload, feedback }, { complete_json: async (...args) => { calls.push(args.slice(0, 7)); return complete(...args); } }));
    requests.push(calls);
  }
  assert.equal(results[0].status, 'published'); assert.equal(results[1].status, 'published');
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(results[0].item.evidence_pin, results[1].item.evidence_pin);
});

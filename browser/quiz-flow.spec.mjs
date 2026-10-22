// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test';

const candidateResponse = { login: 'fixture-user', repository: 'fixture/repo', candidates: [{ number: 42, title: 'Contain dependency failures', merged_at: '2026-09-20T00:00:00Z' }] };
const catalogResponse = { graph_build_id: 'graph-1', complete: true, repositories: [], services: [], scopes: { lld: { eligible: false, reason: 'fixture', claim_count: 0, path_count: 0 }, service: { eligible: false, reason: 'fixture', claim_count: 0, path_count: 0 }, hld: { eligible: false, reason: 'fixture', claim_count: 0, path_count: 0 } }, diagnostics: [] };
const generatedResponse = {
  status: 'published', model: 'fixture-model', usage: { total_tokens: 10 }, cached: false,
  evidence: { pr: { number: 42, title: 'Contain dependency failures', url: 'https://example.test/pr/42' }, source_count: 1, exclusions: [] },
  input_sources: [{ source_id: 'source_1', kind: 'source_file', path_or_url: 'src/api.js' }],
  output: { item: {
    question_type: 'mental_model', question_format: 'scenario_prediction', learning_level: 'applied', review_stage: 'first_exposure',
    mental_model: 'A service boundary contains dependency failures.',
    context: { text: 'An API calls a dependency through an explicit boundary.', citations: { source_ids: ['source_1'], architecture_refs: [] } },
    immediate_work_payoff: { text: 'Recognize which caller owns failure handling.', citations: { source_ids: ['source_1'], architecture_refs: [] } },
    question: { text: 'Where should the dependency failure be contained?', citations: { source_ids: ['source_1'], architecture_refs: [] } },
    answer_options: [
      { id: 'A', text: 'At the calling boundary.', citations: { source_ids: ['source_1'], architecture_refs: [] } },
      { id: 'B', text: 'In an unrelated worker.', citations: { source_ids: ['source_1'], architecture_refs: [] } },
      { id: 'C', text: 'By deleting the dependency.', citations: { source_ids: ['source_1'], architecture_refs: [] } },
    ],
    correct_option_id: 'A', expected_concepts: [{ text: 'Failure boundary', citations: { source_ids: ['source_1'] } }],
    explanation_claims: [{ text: 'The caller owns the failure at the boundary.', citations: { source_ids: ['source_1'] } }],
    answer_analysis: { text: 'A is uniquely correct. B fails because it is unrelated. C fails because deletion is unsupported.', citations: { source_ids: ['source_1'] } },
    evidence_pin: { repository_revision: 'abc' },
  } },
};

test('preparation details expose model time and retries without treating cached timings as a new wait', async ({ page }) => {
  let calls = 0;
  await fixtureApis(page, { generation: route => {
    calls++;
    const timings = { evidence_ms: 1250, generation_ms: 90_000, validation_ms: 5, review_ms: 30_000, total_ms: 121_255 };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...generatedResponse, timings, cached: calls === 2, generation_attempts: [
      { generation_attempt: 1, review_attempt: 1, stage: 'adversarial_review', decision: 'revise' },
      { generation_attempt: 2, review_attempt: 1, stage: 'adversarial_review', decision: 'pass' },
    ] }) });
  } });
  await page.goto('/');
  await page.locator('#generate').click();
  await expect(page.locator('#preparation-details')).toBeVisible();
  await page.locator('#preparation-details > summary').click();
  await expect(page.locator('#preparation-details')).toContainText('Create question 90s');
  await expect(page.locator('#preparation-details')).toContainText('Check answer 30s');
  await expect(page.locator('#preparation-details')).toContainText('Generation attempts: 2');
  await expect(page.locator('#preparation-details')).toContainText('Review attempts: 2');
  await page.locator('#generate').click();
  await expect(page.locator('#preparation-details')).toContainText('Saved question loaded');
  await expect(page.locator('#preparation-details')).not.toContainText('90s');
  await page.locator('#scope').selectOption('lld');
  await expect(page.locator('#preparation-details')).toBeHidden();
});

async function fixtureApis(page, { generation = generatedResponse, candidateStatus = 200, catalog = catalogResponse, architectureGeneration, historyImports, historyStatus = 200 } = {}) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/status') return json({ status: 'ready', model_provider: { name: 'fixture-generator', model: 'fixture-model' }, reviewer_provider: { name: 'fixture-reviewer', model: 'fixture-review-model' }, privacy: { execution: 'local', source_egress: false } });
    if (path === '/api/candidates') return json(candidateStatus === 200 ? candidateResponse : { error: 'Candidate provider unavailable.' }, candidateStatus);
    if (path === '/api/architecture/catalog') return json(catalog);
    if (path === '/api/architecture/practice/prefetch') return route.fulfill({ status: 204, body: '' });
    if (path === '/api/architecture/practice/generate' && architectureGeneration) return architectureGeneration(route);
    if (path === '/api/history') return json(historyStatus === 200 ? { records: [] } : { error_code: 'history_store_corrupt' }, historyStatus);
    if (path === '/api/history/import') { historyImports?.push(route.request().postDataJSON().records[0]); return json({ imported: 1, duplicates: 0 }); }
    if (path === '/api/generate') return typeof generation === 'function' ? generation(route) : json(generation);
    return json({ error: 'not found' }, 404);
  });
}

test('learner can generate, answer, save, search, and review an attempt', async ({ page }) => {
  const historyImports = [];
  await fixtureApis(page, { historyImports });
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('Ready as fixture-user');
  await expect(page.locator('#provider-status')).toContainText('fixture-generator · fixture-model');
  await expect(page.locator('#reviewer-status')).toHaveText('fixture-reviewer · fixture-review-model');
  await page.locator('#generate').click();
  await expect(page.locator('#level')).toHaveCount(0);
  await expect(page.locator('#item .learning-level')).toHaveText('applied');
  await expect(page.locator('#item h2')).toHaveText('Where should the dependency failure be contained?');
  await expect(page.locator('#options')).toHaveAttribute('role', 'radiogroup');
  const options = page.locator('.option');
  await options.nth(1).focus(); await options.nth(1).press('ArrowDown'); await expect(options.nth(2)).toBeFocused();
  await options.nth(0).click();
  await expect(page.locator('#submit')).toBeEnabled(); await page.locator('#submit').click();
  await expect(page.locator('#reveal')).toContainText('Correct: A');
  await expect(page.locator('details.feedback')).not.toHaveAttribute('open', '');
  await expect(page.locator('details.feedback summary')).toBeVisible();
  await expect(page.locator('#history-nav-count')).toHaveText('1');
  await page.locator('#history-tab').click();
  await expect(page.locator('.history-entry-button')).toHaveCount(1);
  await expect(page.locator('#history-review')).toContainText('No feedback was saved for this attempt.');
  await page.locator('#practice-tab').click();
  await page.locator('details.feedback summary').click();
  await expect(page.locator('details.feedback')).toHaveAttribute('open', '');
  await expect(page.locator('#reveal')).toContainText('it does not currently change question generation');
  await page.getByRole('button', { name: 'Strengthened my mental model' }).click();
  await page.locator('#subjective-feedback').fill('Useful boundary example.');
  await page.locator('#save-feedback').click();
  await expect(page.locator('#save-note')).toContainText('Feedback updated in durable local history');
  await expect(page.locator('#history-nav-count')).toHaveText('1');
  await expect.poll(() => historyImports.length).toBe(2);
  expect(historyImports[0].record_id).toBe(historyImports[1].record_id);
  expect(historyImports[0].feedback).toEqual({});
  expect(historyImports[1].feedback.subjective).toBe('Useful boundary example.');

  await page.locator('#history-tab').click();
  await expect(page.locator('#history-view')).toBeVisible();
  await expect(page.locator('.history-entry-button')).toHaveCount(1);
  await expect(page.locator('#history-review')).toContainText('Where should the dependency failure be contained?');
  await expect(page.locator('#history-review')).toContainText('Useful boundary example.');
  await page.locator('#history-search').fill('no such question');
  await expect(page.locator('#history-empty')).toContainText('No matching attempts');
  await page.locator('#history-search').fill('dependency failure');
  await expect(page.locator('.history-entry-button')).toHaveCount(1);
});

test('answered PR questions remain in repeat avoidance after a reload without saving feedback', async ({ page }) => {
  const requests = [];
  await fixtureApis(page, { generation: (route) => { requests.push(JSON.parse(route.request().postData())); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(generatedResponse) }); } });
  await page.goto('/');
  await expect(page.locator('#generate')).toBeEnabled();
  await page.locator('#generate').click();
  await expect(page.locator('#show')).toBeVisible();
  await page.locator('#show').click();
  await page.reload();
  await expect(page.locator('#history-nav-count')).toHaveText('1');
  await expect(page.locator('#generate')).toBeEnabled();
  await page.locator('#generate').click();
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => !Object.hasOwn(request, 'learning_level'))).toBe(true);
  expect(requests[1].exclude_pr_numbers).toContain(42);
  expect(requests[1].prior_questions).toEqual(expect.arrayContaining([{ pr_number: 42, question: generatedResponse.output.item.question.text }]));
});

test('selected architecture boundary and answered question reach the next generation request', async ({ page }) => {
  const requests = [];
  const question = 'Which component owns this request boundary?';
  const architecture = {
    status: 'published', model: 'fixture-model', item: {
      scope: 'lld', learning_level: 'systems', question_type: 'component_role', mental_model_kind: 'responsibility', mental_model: 'The handler owns the request boundary.', context: 'A handler receives the request.', question,
      answer_options: [{ id: 'A', text: 'The handler.' }, { id: 'B', text: 'An unrelated worker.' }, { id: 'C', text: 'The storage driver.' }], correct_option_id: 'A', explanation: 'The handler owns this request. It checks the incoming contract.', supporting_claim_ids: ['claim-1'],
    }, architecture: { graph_build_id: 'graph-1', revision_vector: {}, claims: [], paths: [] },
  };
  await fixtureApis(page, {
    catalog: { ...catalogResponse, services: [{ id: 'service-a', name: 'Service A', resolved: true, boundary_role: 'deployable', repository_id: 'repo' }], scopes: { ...catalogResponse.scopes, lld: { eligible: true, claim_count: 1, path_count: 0 }, hld: { eligible: true, claim_count: 1431, path_count: "9007199254740993" } } },
    architectureGeneration: (route) => { requests.push(JSON.parse(route.request().postData())); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(architecture) }); },
  });
  await page.goto('/');
  await page.locator('#scope').selectOption('hld');
  await expect(page.locator('#source-preview')).toHaveText('Ready to generate · 1.4 k source relationships · 9007.2 tn dependency paths');
  await expect(page.locator('#source-preview')).toHaveAttribute('title', '1,431 source relationships · 9,007,199,254,740,993 dependency paths');
  await page.locator('#scope').selectOption('lld');
  await expect(page.locator('#source-preview')).toHaveText('Ready to generate · 1 source relationship');
  await page.locator('#anchor').selectOption('service-a');
  await page.locator('#generate').click();
  await expect(page.locator('#show')).toBeVisible();
  await page.locator('#show').click();
  await page.reload();
  await page.locator('#scope').selectOption('lld');
  await page.locator('#anchor').selectOption('service-a');
  await page.locator('#generate').click();
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => !Object.hasOwn(request, 'learning_level'))).toBe(true);
  expect(requests[0].learner_node_ids).toEqual(['service-a']);
  expect(requests[1].learner_node_ids).toEqual(['service-a']);
  expect(requests[1].prior_questions).toContain(question);
  expect(requests[0].selection_id).toBeTruthy();
  expect(requests[1].selection_id).not.toBe(requests[0].selection_id);
  await expect(page.locator('#item .learning-level')).toHaveText('systems');
});

test('button typography is consistent and mobile layouts do not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixtureApis(page);
  await page.goto('/');
  await page.locator('#generate').click();
  const typography = await page.locator('button:visible').evaluateAll((buttons) => buttons.map((button) => {
    const style = getComputedStyle(button); return { family: style.fontFamily, letterSpacing: style.letterSpacing };
  }));
  expect(new Set(typography.map(({ family }) => family)).size).toBe(1);
  expect(new Set(typography.map(({ letterSpacing }) => letterSpacing)).size).toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.locator('#history-tab').click();
  await expect(page.locator('.history-layout')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test('a local checkout offers PR questions while architecture indexing gates generation', async ({ page }) => {
  let candidateCalls = 0;
  let releaseCatalog;
  const catalogReady = new Promise((resolve) => { releaseCatalog = resolve; });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/candidates') { candidateCalls += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(candidateResponse) }); }
    if (path === '/api/architecture/catalog') await catalogReady;
    const body = path === '/api/status' ? { status: 'ready', source_provider: { name: 'local-git' } }
      : path === '/api/architecture/catalog' ? catalogResponse : { records: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  await expect(page.locator('#scope')).toHaveValue('pr');
  await expect(page.locator('#scope option[value="pr"]')).toBeEnabled();
  await expect(page.locator('#status')).toContainText('Ready as fixture-user');
  await expect(page.locator('#source-preview')).toContainText('New question from 1 recent PR');
  await page.locator('#selection').selectOption('spaced_recall');
  await expect(page.locator('#source-preview')).toHaveText('Prefers PRs merged at least 30 days ago that you practised at least seven days ago. Otherwise, prefers other older PRs, then recent PRs.');
  await expect(page.locator('#generate')).toBeEnabled();
  expect(candidateCalls).toBe(1);
  await page.locator('#scope').selectOption('lld');
  await expect(page.locator('#generate')).toBeDisabled();
  await expect(page.locator('#source-preview')).toContainText('Indexing');
  releaseCatalog();
  await expect(page.locator('#generate')).toBeEnabled();
});

test('late PR discovery does not replace architecture generation progress', async ({ page }) => {
  let releaseCandidates;
  const candidatesReady = new Promise((resolve) => { releaseCandidates = resolve; });
  let candidateDelivered;
  const delivery = new Promise((resolve) => { candidateDelivered = resolve; });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/candidates') { await candidatesReady; await json(candidateResponse); candidateDelivered(); return; }
    if (path === '/api/status') return json({ status: 'ready', source_provider: { name: 'local-git' } });
    if (path === '/api/history') return json({ records: [] });
    if (path === '/api/architecture/catalog') return json(catalogResponse);
    if (path === '/api/architecture/practice/generate') return new Promise((resolve) => setTimeout(() => resolve(json({ status: 'abstained', reason_code: 'fixture' })), 5_000));
    return json({});
  });
  await page.goto('/');
  await page.locator('#scope').selectOption('lld');
  await expect(page.locator('#generate')).toBeEnabled();
  await page.locator('#generate').click();
  await expect(page.locator('#status .work-title')).toHaveText('Building a grounded question');
  releaseCandidates();
  await delivery;
  await expect(page.locator('#status .work-title')).toHaveText('Building a grounded question');
  await page.waitForTimeout(1_100);
  expect(pageErrors).toEqual([]);
  await page.locator('#cancel-generation').click();
});

test('candidate failures expose a retry action and generation cancellation restores controls', async ({ page }) => {
  let candidates = 0;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/candidates') { candidates += 1; return json(candidates === 1 ? { error: 'Temporary source failure.' } : candidateResponse, candidates === 1 ? 502 : 200); }
    if (path === '/api/status') return json({ status: 'ready' });
    if (path === '/api/history') return json({ records: [] });
    if (path === '/api/architecture/catalog') return json(catalogResponse);
    if (path === '/api/generate') return new Promise((resolve) => setTimeout(() => resolve(json(generatedResponse)), 5_000));
    return json({});
  });
  await page.goto('/');
  await expect(page.locator('#retry-candidates')).toBeVisible();
  await expect(page.locator('#scope')).toHaveValue('lld');
  await expect(page.locator('#status')).toContainText('Switched to local component design questions');
  await expect(page.locator('#generate')).toBeEnabled();
  await page.locator('#retry-candidates').click();
  await expect(page.locator('#status')).toContainText('Ready as fixture-user');
  await page.locator('#scope').selectOption('pr');
  await page.locator('#generate').click();
  await expect(page.locator('#cancel-generation')).toBeVisible();
  await expect(page.locator('#status .work-title')).toHaveText('Building a grounded question');
  await expect(page.locator('#status .work-clock')).toContainText('elapsed');
  await page.locator('#cancel-generation').click();
  await expect(page.locator('#status')).toContainText('Generation cancelled');
  await expect(page.locator('#status .work-state')).toHaveCount(0);
  await expect(page.locator('#generate')).toBeEnabled();
});

test('model failures use learner-facing copy and keep diagnostics collapsed', async ({ page }) => {
  await fixtureApis(page, { generation: {
    status: 'rejected', rejection_stage: 'generation', reason_code: 'model_output_schema_violation',
    generation_attempts: [{ generation_attempt: 1 }, { generation_attempt: 2 }],
    validation_errors: ['Model output failed schema validation: $.answer_a is required'],
  } });
  await page.goto('/');
  await page.locator('#generate').click();
  await expect(page.locator('#status')).toContainText('No question was published');
  await expect(page.locator('#status')).toContainText('Tried twice');
  await expect(page.locator('#status')).not.toContainText('Stage:');
  await expect(page.locator('#status details')).not.toHaveAttribute('open', '');
  await expect(page.locator('#status summary')).toHaveText('Technical details');
});

test('changing architecture scope or boundary cancels stale prefetch and Cancel stops matching warm-up', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.abortedPrefetches = 0;
    window.fetch = (...args) => {
      if (String(args[0]).endsWith('/api/architecture/practice/prefetch')) args[1]?.signal?.addEventListener('abort', () => { window.abortedPrefetches++; });
      return originalFetch(...args);
    };
  });
  await fixtureApis(page, { catalog: {
    ...catalogResponse,
    services: [{ id: 'service-a', name: 'Service A', resolved: true, repository_id: 'repo' }],
    scopes: { ...catalogResponse.scopes, hld: { eligible: true, claim_count: 2, path_count: 1 }, service: { eligible: true, claim_count: 2, path_count: 0 } },
  } });
  let release; const pending = new Promise((resolve) => { release = resolve; }); const requests = [];
  await page.route('**/api/architecture/practice/prefetch', async (route) => {
    requests.push(route.request().postDataJSON());
    await pending;
    await route.fulfill({ status: 204, body: '' }).catch(() => {});
  });
  try {
    await page.goto('/');
    await page.locator('#scope').selectOption('hld');
    await expect.poll(() => requests.length).toBe(1);
    await page.locator('#scope').selectOption('service');
    await expect.poll(() => page.evaluate(() => window.abortedPrefetches)).toBe(1);
    await expect.poll(() => requests.length).toBe(2);
    await page.locator('#anchor').selectOption('service-a');
    await expect.poll(() => page.evaluate(() => window.abortedPrefetches)).toBe(2);
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2].learner_node_ids).toEqual(['service-a']);
    await page.locator('#generate').click();
    await page.locator('#cancel-generation').click();
    await expect.poll(() => page.evaluate(() => window.abortedPrefetches)).toBe(3);
    await expect(page.locator('#generate')).toBeEnabled();
    await expect(page.locator('#status')).not.toContainText('capacity is busy');
  } finally { release(); }
});

const serviceQuestion = {
  status: 'published', model: 'fixture-model', item: {
    scope: 'service', learning_level: 'applied', question_type: 'component_role',
    mental_model_kind: 'responsibility', mental_model: 'The caller owns dependency failures.',
    context: 'The API calls a worker.', question: 'Which service owns this failure boundary?',
    answer_options: [{ id: 'A', text: 'The API.' }, { id: 'B', text: 'The database.' }, { id: 'C', text: 'An unrelated worker.' }],
    correct_option_id: 'A', explanation: 'The caller handles this failure.', supporting_claim_ids: ['claim-1'],
  }, architecture: { graph_build_id: 'graph-1', revision_vector: {}, claims: [], paths: [] },
};

test('scope changes clear the previous question before HLD abstention', async ({ page }) => {
  await fixtureApis(page, { architectureGeneration: (route) => {
    const { scope } = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(scope === 'service' ? serviceQuestion : { status: 'abstained', reason_code: 'insufficient_evidence', claim_count: 0, path_count: 0 }) });
  } });
  await page.goto('/');
  await page.locator('#scope').selectOption('service');
  await page.locator('#generate').click();
  await expect(page.locator('#item h2')).toHaveText(serviceQuestion.item.question);
  await page.locator('#scope').selectOption('hld');
  await expect(page.locator('#item')).toBeHidden();
  await expect(page.locator('#item')).toBeEmpty();
  await expect(page.locator('#question-empty')).toBeVisible();
  await page.locator('#generate').click();
  await expect(page.locator('#status')).toContainText('No question is shown because the evidence is not sufficient');
  await expect(page.locator('#item')).toBeEmpty();
  await expect(page.locator('#question-empty-title')).toHaveText('No question was published');
  await expect(page.locator('#status')).toContainText('Evidence reason: insufficient evidence. Claims: 0; dependency paths: 0');
  await expect(page.locator('#show')).toHaveCount(0);
  await expect(page.locator('#save-feedback')).toHaveCount(0);
  await expect(page.locator('#status')).not.toContainText('graph-1');
});

test('changing the architecture boundary clears answer and feedback controls', async ({ page }) => {
  await fixtureApis(page, { catalog: { ...catalogResponse, services: [{ id: 'service-a', name: 'Service A', resolved: true, repository_id: 'repo' }] }, architectureGeneration: (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(serviceQuestion) }) });
  await page.goto('/');
  await page.locator('#scope').selectOption('service');
  await page.locator('#generate').click();
  await page.locator('#show').click();
  await expect(page.locator('#reveal')).toBeVisible();
  await page.locator('#anchor').selectOption('service-a');
  await expect(page.locator('#item')).toBeEmpty();
  await expect(page.locator('#question-empty')).toBeVisible();
  await expect(page.locator('#show')).toHaveCount(0);
  await expect(page.locator('#save-feedback')).toHaveCount(0);
});

test('skip link appears only with keyboard focus', async ({ page }) => {
  await fixtureApis(page);
  await page.goto('/');
  const skip = page.getByRole('link', { name: 'Skip to learning workspace', includeHidden: true });
  await expect(skip).not.toBeInViewport();
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press('Tab');
  await expect(skip).not.toBeInViewport();
});

 test('corrupt durable history is explicit while browser attempts remain reviewable', async ({ page }) => {
  await page.addInitScript((record) => localStorage.setItem('codebase-trail-feedback-v1', JSON.stringify([record])), {
    record_id:'browser-preserved', source_scope:'lld', generation:{question:{question:'Existing browser attempt?',answer_options:[{id:'A',text:'API'}],correct_option_id:'A'}}, learner_answer:{selected_option_id:'A',was_correct:true},feedback:{},
  });
  await fixtureApis(page, { historyStatus:503 });
  await page.goto('/');await page.locator('#history-tab').click();
  await expect(page.locator('#history-storage-status')).toBeVisible();
  await expect(page.locator('#history-storage-status')).toContainText('repair');
  await expect(page.locator('#history-list')).toContainText('Existing browser attempt?');
  await expect(page.locator('#history-review')).toContainText('Existing browser attempt?');
  await expect(page.locator('#export-feedback')).toBeEnabled();
});

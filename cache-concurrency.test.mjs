// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConcurrencyGate, createArchitecturePracticeGenerator } from './server.mjs';

const payload = { selection_id: 'fixture-selection', scope: 'lld', learner_node_ids: ['component:a'], learning_level: 'systems' };
const analysis = { graph: { buildId: 'build-1' } };
const published = { status: 'published', item: { question: 'Q' }, architecture: { claims: [] }, timings: { generation_ms: 1 } };

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const values = new Map(); const writes = []; let generations = 0;
  const cache = overrides.cache || {
    async get(buildId, dimensions) { return values.get(`${buildId}:${JSON.stringify(dimensions)}`); },
    async set(buildId, dimensions, value) { writes.push(value); values.set(`${buildId}:${JSON.stringify(dimensions)}`, value); },
  };
  const generate = overrides.generate || (async () => published);
  const run = createArchitecturePracticeGenerator({
    load_snapshots: async () => [{ repository_id: 'fixture', revision: 'abc', files: [] }],
    analyze: async () => analysis,
    generate: async (...args) => { generations += 1; return generate(...args); },
    cache,
    inflight: new Map(),
    generation_gate: overrides.generation_gate || createConcurrencyGate(2),
    log_error: overrides.log_error || (() => {}),
  });
  return { run, values, writes, get generations() { return generations; } };
}

test('concurrent architecture requests share one model generation and persist once', async () => {
  const pending = deferred();
  const h = harness({ generate: async () => pending.promise });
  const first = h.run(payload); const second = h.run(payload);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.generations, 1);
  pending.resolve(published);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'published');
  assert.equal(b.prefetched, true);
  assert.equal(h.writes.length, 1);
});

test('one cancelled waiter does not abort shared generation while another remains', async () => {
  const pending = deferred(); let underlyingSignal;
  const h = harness({ generate: async (_payload, governance) => { underlyingSignal = governance.signal; return pending.promise; } });
  const abandoned = new AbortController();
  const first = h.run(payload, abandoned.signal); const second = h.run(payload);
  await new Promise((resolve) => setImmediate(resolve));
  abandoned.abort(new Error('caller left'));
  await assert.rejects(first, /caller left/);
  assert.equal(underlyingSignal.aborted, false);
  pending.resolve(published);
  assert.equal((await second).status, 'published');
});

test('shared generation aborts when every waiter cancels', async () => {
  let underlyingSignal; const observed = deferred();
  const h = harness({ generate: async (_payload, governance) => {
    underlyingSignal = governance.signal;
    governance.signal.addEventListener('abort', () => observed.resolve(governance.signal.reason), { once: true });
    return new Promise((_, reject) => governance.signal.addEventListener('abort', () => reject(governance.signal.reason), { once: true }));
  } });
  const a = new AbortController(); const b = new AbortController();
  const first = h.run(payload, a.signal); const second = h.run(payload, b.signal);
  await new Promise((resolve) => setImmediate(resolve));
  a.abort(new Error('a left')); b.abort(new Error('b left'));
  await Promise.allSettled([first, second]);
  const reason = await observed.promise;
  assert.equal(underlyingSignal.aborted, true);
  assert.match(reason.message, /All clients abandoned/);
});

test('published cache hits bypass generation and rejected results are not cached', async () => {
  const hit = harness();
  await hit.run(payload);
  const cached = await hit.run(payload);
  assert.equal(hit.generations, 1);
  assert.equal(cached.cached, true);
  assert.equal(cached.prefetched, true);

  const rejected = harness({ generate: async () => ({ status: 'rejected', reason_code: 'not_approved' }) });
  await rejected.run(payload); await rejected.run(payload);
  assert.equal(rejected.generations, 2);
  assert.equal(rejected.writes.length, 0);
});

test('answered history and selected boundary partition cached architecture questions', async () => {
  const seen = [];
  const h = harness({ generate: async (request) => {
    seen.push({ prior: request.prior_questions, anchor: request.learner_node_ids });
    return { ...published, item: { question: `Question ${seen.length}` } };
  } });
  const first = await h.run(payload);
  const cached = await h.run(payload);
  assert.equal(cached.cached, true);
  assert.equal(cached.item.question, first.item.question);

  const afterAnswer = await h.run({ ...payload, prior_questions: [first.item.question] });
  assert.equal(afterAnswer.cached, false);
  assert.notEqual(afterAnswer.item.question, first.item.question);
  assert.deepEqual(seen[1], { prior: [first.item.question], anchor: ['component:a'] });

  const anotherBoundary = await h.run({ ...payload, learner_node_ids: ['component:b'] });
  assert.equal(anotherBoundary.cached, false);
  assert.equal(h.generations, 3);
  assert.deepEqual(seen[2].anchor, ['component:b']);
});

test('cache write failures are reported but never fail a published question', async () => {
  const errors = [];
  const h = harness({
    cache: { async get() {}, async set() { throw new Error('disk full'); } },
    log_error: (...args) => errors.push(args),
  });
  const result = await h.run(payload);
  assert.equal(result.status, 'published');
  assert.equal(errors.length, 1);
  assert.match(errors[0][1].message, /disk full/);
});

test('fresh architecture selections do not reopen a prior question', async () => {
  const h = harness();
  await h.run({ ...payload, selection_id: 'first-selection' });
  const second = await h.run({ ...payload, selection_id: 'second-selection' });
  assert.equal(second.cached, false);
  assert.equal(h.generations, 2);
  const { selection_id: _selectionId, ...withoutSelection } = payload;
  await h.run(withoutSelection); await h.run(withoutSelection);
  assert.equal(h.generations, 4);
});

test('random-level prefetch and foreground requests share one slot; fresh work waits for capacity', async () => {
  const gate = createConcurrencyGate(1); const pending = new Map(); const levels = [];
  const h = harness({ generation_gate: gate, generate: async (request) => {
    levels.push(request.learning_level);
    const task = deferred(); pending.set(request.selection_id, task);
    return task.promise;
  } });
  const { learning_level: _learningLevel, ...randomPayload } = payload;
  const background = h.run(randomPayload, undefined, { background: true });
  const foreground = h.run(randomPayload);
  const next = h.run({ ...randomPayload, selection_id: 'next-selection' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.active, 1); assert.equal(h.generations, 1);
  pending.get(randomPayload.selection_id).resolve(published);
  const [a, b] = await Promise.all([background, foreground]);
  assert.equal(a.status, 'published'); assert.equal(b.prefetched, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.generations, 2); assert.equal(gate.active, 1);
  // A cache hit must bypass the saturated generation gate entirely.
  assert.equal((await h.run(randomPayload)).cached, true);
  assert.equal(h.generations, 2);
  pending.get('next-selection').resolve(published);
  assert.equal((await next).status, 'published');
  assert.equal(gate.active, 0);
  assert.ok(levels.every((level) => ['foundational', 'applied', 'systems'].includes(level)));
});

test('cancelling a queued architecture request removes it before any model call', async () => {
  const gate = createConcurrencyGate(1); const running = deferred();
  const h = harness({ generation_gate: gate, generate: async () => running.promise });
  const first = h.run(payload);
  const cancelled = new AbortController();
  const second = h.run({ ...payload, selection_id: 'cancelled-selection' }, cancelled.signal);
  await new Promise((resolve) => setImmediate(resolve));
  cancelled.abort(new Error('learner changed scope'));
  await assert.rejects(second, /learner changed scope/);
  running.resolve(published); await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.generations, 1); assert.equal(gate.active, 0);
});

test('queued foreground generation runs before background work and releases slots after failure', async () => {
  const gate = createConcurrencyGate(1); const pending = deferred(); const order = [];
  const active = gate.run(() => pending.promise);
  const background = gate.run(async () => { order.push('background'); }, { wait: true, priority: 1 });
  const foreground = gate.run(async () => { order.push('foreground'); throw new Error('model failed'); }, { wait: true });
  const failed = assert.rejects(foreground, /model failed/);
  pending.resolve(); await active; await failed; await background;
  assert.deepEqual(order, ['foreground', 'background']);
  assert.equal(gate.active, 0);
});

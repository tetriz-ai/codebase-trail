// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuizStore, migrateQuizStoreDocument, QuizStoreValidationError } from './quiz-store.mjs';

const record = (id) => ({ id, question: `Who owns ${id}?`, question_fingerprint: `question-${id}`, evidence_fingerprint: `evidence-${id}`, evidence_pin: { revision: id }, state: 'published', attempts: [] });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'history-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'history.json');
  return { directory, filePath, store: createQuizStore({ filePath, ...options }) };
}
async function disk(directory) {
  return Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name), 'utf8')])));
}
const operations = {
  initialize: store => store.initialize(), get: store => store.get('a'), list: store => store.list(),
  export: store => store.exportPortable(), append: store => store.append({ question: 'New?', evidence_pin: { revision: 'new' } }),
  update: store => store.update('a', { explanation: 'Explanation' }), transition: store => store.transition('a', 'retired'),
  attempt: store => store.recordAttempt('a', { selected: 'A' }), feedback: store => store.updateAttemptFeedback('a', 'attempt', {}),
  schedule: store => store.scheduleReview('a'), portable: store => store.importPortable({ schema_version: 1, records: [record('b')] }),
  feedbackImport: store => store.importFeedbackRecords([]),
};
for (const [name, operation] of Object.entries(operations)) test(`missing backup preserves corruption through ${name}`, async t => {
  const { directory, filePath, store } = await fixture(t);
  await writeFile(filePath, '{}\n'); const before = await disk(directory);
  await assert.rejects(operation(store), { code: 'history_store_corrupt' });
  assert.deepEqual(await disk(directory), before);
});

const invalidCurrent = [
  { schema_version: 1 }, { schema_version: 1, records: null }, { schema_version: 1, records: {} },
  { schema_version: 1, records: [{}] },
  { schema_version: 1, records: [record('a'), record('a')] },
  { schema_version: 1, records: [record('a'), { ...record('a'), id: 'other' }] },
  { schema_version: 1, records: [{ ...record('a'), evidence_pin: { raw_source: 'fixture' } }] },
];
for (const [index, invalid] of invalidCurrent.entries()) test(`invalid current document ${index} preserves primary and backup`, async t => {
  const { directory, filePath, store } = await fixture(t);
  for (const [primary, backup] of [[{}, invalid], [invalid, {}]]) {
    await writeFile(filePath, JSON.stringify(primary)); await writeFile(`${filePath}.bak`, JSON.stringify(backup));
    const before = await disk(directory);
    await assert.rejects(store.list(), { code: 'history_store_corrupt' });
    await assert.rejects(store.append({ question: 'New?', evidence_pin: {} }), { code: 'history_store_corrupt' });
    assert.deepEqual(await disk(directory), before);
  }
});
test('legacy arrays prefer records with distinct and empty neighbors', () => {
  for (const records of [[], [record('a')]]) for (const questions of [[], [record('b')]]) {
    assert.deepEqual(migrateQuizStoreDocument({ records, questions }).records, records);
    assert.deepEqual(migrateQuizStoreDocument({ schema_version: 0, records, questions }).records, records);
  }
});
test('exported migration rejects nonfinite JavaScript schema tags', () => {
  for (const schema_version of [NaN, Infinity, -Infinity]) assert.throws(() => migrateQuizStoreDocument({ schema_version, records: [] }), QuizStoreValidationError);
});
for (const [field, version] of [['records', undefined], ['questions', undefined], ['records', 0], ['questions', 0], ['records', 1]]) {
  test(`multiple owners repeatedly recover ${field} schema ${version ?? 'untagged'} backup`, async t => {
    const { directory, filePath } = await fixture(t);
    const records = [record('a')];
    const backup = JSON.stringify({ [field]: records, ...(version === undefined ? {} : { schema_version: version }) });
    await writeFile(`${filePath}.bak`, backup);
    const owners = Array.from({ length: 4 }, () => createQuizStore({ filePath }));
    for (const [round, corrupt] of ['{}', '{"schema_version":1,"records":null}'].entries()) {
      await writeFile(filePath, corrupt);
      const views = await Promise.all(owners.map(store => store.list()));
      for (const view of views) assert.deepEqual(view, records);
      assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).records, records);
      assert.equal(await readFile(`${filePath}.bak`, 'utf8'), backup);
      const copies = (await readdir(directory)).filter(name => name.includes('.corrupt-'));
      assert.equal(copies.length, round + 1);
      assert.ok((await Promise.all(copies.map(name => readFile(join(directory, name), 'utf8')))).includes(corrupt));
      for (const name of copies) {
        const preservedFile = await stat(join(directory, name));
        assert.equal(preservedFile.isFile(), true);
        if (process.platform !== 'win32') assert.equal(preservedFile.mode & 0o777, 0o600);
      }
    }
  });
}
for (const [capacity, count] of [[1000, 251], [1000, 1000], [300, 300], [300, 301]]) test(`legacy questions capacity ${count} with maximum ${capacity}`, async t => {
  const { directory, filePath, store } = await fixture(t, { maxRecords: capacity });
  await store.initialize(); const before = await disk(directory);
  const records = Array.from({ length: count }, (_, index) => record(`item-${index}`));
  const input = { questions: records };
  if (count > capacity) {
    await assert.rejects(store.importPortable(input), /record limit/);
    assert.deepEqual(await disk(directory), before);
  } else {
    assert.equal((await store.importPortable(input)).imported, count);
    assert.deepEqual((await store.exportPortable()).records, records);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).records.length, count);
  }
});
test('legacy questions keep nested array and raw payload limits with atomic rejection', async t => {
  const { directory, store } = await fixture(t);
  const valid = { ...record('a'), evidence_pin: { values: Array(250).fill('bounded') } };
  assert.equal((await store.importPortable({ questions: [valid] })).imported, 1);
  for (const evidence_pin of [{ values: Array(251).fill('bounded') }, { prompt: 'fixture' }, { nested: { raw_source: 'fixture' } }]) {
    const before = await disk(directory);
    await assert.rejects(store.importPortable({ questions: [{ ...record('b'), evidence_pin }] }), /250 entries|not portable/);
    assert.deepEqual(await disk(directory), before);
  }
});

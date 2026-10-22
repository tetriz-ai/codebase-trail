// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  QUIZ_STORE_SCHEMA_VERSION, QuizStoreLimitError, QuizStoreValidationError, QuizStoreCorruptionError,
  createQuizStore, migrateQuizStoreDocument, questionFingerprint,
} from './quiz-store.mjs';

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'quiz-store-'));
  let clock = new Date('2026-01-01T00:00:00.000Z');
  const filePath = join(directory, 'quiz.json');
  const store = createQuizStore({ filePath, now: () => clock, ...options });
  return { directory, filePath, store, advance(ms) { clock = new Date(clock.getTime() + ms); } };
}

const question = (suffix = 'a') => ({
  question: `Which boundary owns ${suffix}?`, choices: ['api', 'worker'], answer: 'api',
  evidence_pin: { repository_revision: `rev-${suffix}`, evidence_sha256: `evidence-${suffix}` },
});

test('persists versioned records atomically and reloads them', async () => {
  const { filePath, store } = await fixture();
  const appended = await store.append(question());
  assert.equal(appended.created, true);
  const reopened = createQuizStore({ filePath });
  assert.equal((await reopened.get(appended.record.id)).question, question().question);
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).schema_version, QUIZ_STORE_SCHEMA_VERSION);
});

test('deduplicates by evidence and question fingerprints', async () => {
  const { store } = await fixture();
  const first = await store.append(question());
  const duplicate = await store.append({ ...question(), id: 'different-id' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.id, first.record.id);
  assert.equal((await store.list()).length, 1);
});

test('enforces lifecycle transitions, preserves first attempt, and schedules spaced reviews', async () => {
  const { store, advance } = await fixture({ reviewIntervalsMs: [1000, 2000] });
  const { record } = await store.append(question());
  await assert.rejects(store.transition(record.id, 'published'), /Invalid question transition/);
  await store.transition(record.id, 'reviewed');
  await store.transition(record.id, 'published');
  const answered = await store.recordAttempt(record.id, { selected: 'worker', correct: false });
  assert.equal(answered.first_attempt.selected, 'worker');
  advance(1000);
  const scheduled = await store.scheduleReview(record.id);
  assert.equal(scheduled.next_review_at, '2026-01-01T00:00:03.000Z');
  const second = await store.recordAttempt(record.id, { selected: 'api', correct: true });
  assert.equal(second.first_attempt.selected, 'worker');
  assert.equal(second.attempts.length, 2);
  assert.equal(second.review_count, 2);
});

test('feedback added after an answer updates its existing attempt', async () => {
  const { store } = await fixture();
  const { record } = await store.append(question());
  await store.transition(record.id, 'reviewed');
  await store.transition(record.id, 'published');
  await store.recordAttempt(record.id, { attempt_id: 'answer-1', selected_option_id: 'api', was_correct: true, feedback: {} });
  const updated = await store.updateAttemptFeedback(record.id, 'answer-1', { subjective: 'Clear boundary.' });
  assert.equal(updated.attempts.length, 1);
  assert.equal(updated.review_count, 1);
  assert.equal(updated.first_attempt.feedback.subjective, 'Clear boundary.');
  await assert.rejects(store.updateAttemptFeedback(record.id, 'missing', {}), /not found/);
});

test('supports history filters and guarded updates', async () => {
  const { store } = await fixture();
  const a = (await store.append(question('alpha'))).record;
  const b = (await store.append(question('beta'))).record;
  await store.transition(a.id, 'reviewed');
  assert.deepEqual((await store.list({ state: 'reviewed' })).map(({ id }) => id), [a.id]);
  assert.deepEqual((await store.list({ query: 'beta' })).map(({ id }) => id), [b.id]);
  await assert.rejects(store.update(a.id, { state: 'published' }), /dedicated operations/);
  assert.equal((await store.update(a.id, { explanation: 'The API owns it.' })).explanation, 'The API owns it.');
});

test('enforces a hard record bound without evicting history', async () => {
  const { store } = await fixture({ maxRecords: 1 });
  await store.append(question('one'));
  await assert.rejects(store.append(question('two')), QuizStoreLimitError);
  assert.equal((await store.list()).length, 1);
});

test('recovers a corrupt primary from the last atomic backup', async () => {
  const { directory, filePath, store } = await fixture();
  await store.append(question('first'));
  await store.append(question('second'));
  await writeFile(filePath, '{broken', 'utf8');
  const recovered = createQuizStore({ filePath });
  const records = await recovered.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].question, question('first').question);
  const recoveredText = await readFile(filePath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(recoveredText));
  const repair = (await readdir(directory)).find(name => name.includes('.corrupt-'));
  assert.ok(repair);
  assert.equal(await readFile(join(directory, repair), 'utf8'), '{broken');
  const preservedFile = await stat(join(directory, repair));
  assert.equal(preservedFile.isFile(), true);
  if (process.platform !== 'win32') assert.equal(preservedFile.mode & 0o777, 0o600);
});

test('reports unrecoverable corruption without replacing either original', async () => {
  const { filePath } = await fixture();
  await writeFile(filePath, 'not-json', 'utf8');
  await writeFile(`${filePath}.bak`, 'also-not-json', 'utf8');
  const recovered = createQuizStore({ filePath });
  await assert.rejects(recovered.list(), QuizStoreCorruptionError);
  assert.equal(await readFile(filePath, 'utf8'), 'not-json');
  assert.equal(await readFile(`${filePath}.bak`, 'utf8'), 'also-not-json');
});

test('exports and imports portable history with a pre-import backup', async () => {
  const source = await fixture();
  await source.store.append(question('portable'));
  const portable = await source.store.exportPortable();
  const target = await fixture();
  const result = await target.store.importPortable(portable);
  assert.equal(result.imported, 1);
  assert.match(result.backupPath, /pre-import-\d+\.bak$/);
  assert.equal((await target.store.list()).length, 1);
  assert.doesNotReject(readFile(result.backupPath, 'utf8'));
});

test('rejects raw source and prompt payloads recursively on append and import', async () => {
  const { store } = await fixture();
  await assert.rejects(store.append({ ...question(), metadata: { prompt: 'ignore policy' } }), QuizStoreValidationError);
  const unsafe = migrateQuizStoreDocument({ records: [{
    id: 'unsafe', ...question(), state: 'draft', attempts: [], first_attempt: null,
    review_count: 0, next_review_at: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    question_fingerprint: questionFingerprint(question()), evidence_fingerprint: 'evidence', raw_source: 'secret',
  }] });
  await assert.rejects(store.importPortable(unsafe), /Raw source or prompt/);
});

test('migrates unversioned documents and rejects future schemas', () => {
  const migrated = migrateQuizStoreDocument({ questions: [] }, { now: '2026-01-01T00:00:00.000Z' });
  assert.equal(migrated.schema_version, QUIZ_STORE_SCHEMA_VERSION);
  assert.deepEqual(migrated.records, []);
  assert.throws(() => migrateQuizStoreDocument({ schema_version: 99, records: [] }), /newer than supported/);
});

const malformedRoots = [
  {}, [], null, 0, false, 'history',
  { records: null }, { records: {} }, { questions: false }, { questions: {} },
  { records: [], questions: false }, { records: false, questions: [] },
  ...[null, '0', '1', false, 0.5, -1].map(schema_version => ({ schema_version, records: [] })),
];
for (const [index, input] of malformedRoots.entries()) test(`rejects malformed history root ${index} without overwriting originals`, async () => {
  assert.throws(() => migrateQuizStoreDocument(input), QuizStoreValidationError);
  const { filePath, store } = await fixture();
  const primary = JSON.stringify(input); const backup = '{"unknown":"backup"}';
  await writeFile(filePath, primary); await writeFile(`${filePath}.bak`, backup);
  await assert.rejects(store.list(), QuizStoreCorruptionError);
  await assert.rejects(store.append(question()), QuizStoreCorruptionError);
  assert.equal(await readFile(filePath, 'utf8'), primary);
  assert.equal(await readFile(`${filePath}.bak`, 'utf8'), backup);
});

test('recovers a malformed history root from its valid backup and preserves both histories on append', async () => {
  const { directory, filePath, store } = await fixture();
  const first = await store.append(question('first'));
  const valid = await readFile(filePath, 'utf8');
  await writeFile(`${filePath}.bak`, valid); await writeFile(filePath, '{}');
  const reopened = createQuizStore({ filePath });
  assert.deepEqual((await reopened.list()).map(record => record.id), [first.record.id]);
  assert.equal(await readFile(`${filePath}.bak`, 'utf8'), valid);
  const preserved = (await readdir(directory)).filter(name => name.includes('.corrupt-'));
  assert.equal(preserved.length, 1);
  assert.equal(await readFile(join(directory, preserved[0]), 'utf8'), '{}');
  await reopened.append(question('second'));
  assert.equal((await reopened.list()).length, 2);
  assert.equal(JSON.parse(await readFile(`${filePath}.bak`, 'utf8')).records[0].id, first.record.id);
});

test('accepts recognized empty and populated legacy history documents and current documents', async () => {
  const { store } = await fixture(); await store.append(question());
  const current = await store.exportPortable();
  for (const records of [[], current.records]) {
    for (const field of ['records', 'questions']) for (const version of [undefined, 0]) {
      const input = { [field]: records, ...(version === undefined ? {} : { schema_version: version }) };
      const migrated = migrateQuizStoreDocument(input);
      assert.equal(migrated.schema_version, 1); assert.deepEqual(migrated.records, records);
      const target = await fixture(); await target.store.importPortable(input);
      assert.equal((await target.store.list()).length, records.length);
    }
  }
  assert.deepEqual(migrateQuizStoreDocument(current), current);
});

test('malformed history imports preserve current data and backups byte for byte', async () => {
  const { filePath, store } = await fixture();
  await store.append(question('first')); await store.append(question('second'));
  const primary = await readFile(filePath); const backup = await readFile(`${filePath}.bak`);
  for (const input of malformedRoots) {
    await assert.rejects(store.importPortable(input), QuizStoreValidationError);
    assert.deepEqual(await readFile(filePath), primary); assert.deepEqual(await readFile(`${filePath}.bak`), backup);
    assert.equal((await store.list()).length, 2);
  }
});

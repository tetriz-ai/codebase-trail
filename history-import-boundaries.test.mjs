// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuizStore } from './quiz-store.mjs';
import { importHistoryRecords } from './server.mjs';

const record = id => ({ id, question: `Who owns ${id}?`, question_fingerprint: `question-${id}`, evidence_fingerprint: `evidence-${id}`, evidence_pin: { revision: id }, state: 'published', attempts: [] });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'history-import-boundaries-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createQuizStore({ filePath: join(directory, 'history.json'), ...options });
  await store.initialize();
  return { store, disk: async () => Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name))]))) };
}
const envelope = (field, version, records) => ({ [field]: records, ...(version === undefined ? {} : { schema_version: version }) });
for (const field of ['records', 'questions']) for (const version of [undefined, 0]) {
  for (const [maxRecords, count] of [[1000, 250], [1000, 251], [1000, 1000], [1000, 1001], [300, 300], [300, 301]]) {
    test(`${field} schema ${version ?? 'absent'} capacity ${count}/${maxRecords}`, async t => {
      const { store, disk } = await fixture(t, { maxRecords });
      const input = envelope(field, version, Array.from({ length: count }, (_, index) => record(`item-${index}`)));
      const before = await disk();
      if (count > maxRecords) {
        await assert.rejects(store.importPortable(input), /record limit/);
        assert.deepEqual(await disk(), before);
      } else {
        assert.equal((await store.importPortable(input)).imported, count);
        assert.deepEqual((await store.exportPortable()).records, input[field]);
      }
    });
  }
}
function depthRecord(depth) {
  let evidence = 'bounded';
  for (let index = 1; index < depth; index += 1) evidence = { nested: evidence };
  return { ...record('depth'), evidence_pin: evidence };
}
function byteRecord(size) {
  // Sixteen bounded evidence strings supply 128000 bytes; one bounded padding
  // string fills the serialized record to the exact limit without private fields.
  const value = { ...record('bytes'), evidence_pin: { chunks: Array(16).fill('x'.repeat(8000)), padding: '' } };
  const padding = size - Buffer.byteLength(JSON.stringify(value));
  assert.ok(padding >= 0 && padding <= 8000);
  value.evidence_pin.padding = 'x'.repeat(padding);
  assert.equal(Buffer.byteLength(JSON.stringify(value)), size);
  return value;
}
for (const [field, version] of [['questions', undefined], ['questions', 0], ['records', 1]]) {
  for (const [name, valid, invalid, error] of [
    ['depth', depthRecord(12), depthRecord(13), /too deeply nested/],
    ['string', { ...record('string'), evidence_pin: { value: 'x'.repeat(8000) } }, { ...record('string'), evidence_pin: { value: 'x'.repeat(8001) } }, /8,000 characters/],
    ['bytes', byteRecord(128 * 1024), byteRecord(128 * 1024 + 1), /128 KiB portable limit/],
  ]) test(`${field} schema ${version ?? 'absent'} exact ${name} limit and rollback`, async t => {
    const { store, disk } = await fixture(t);
    assert.equal((await store.importPortable(envelope(field, version, [valid]))).imported, 1);
    assert.deepEqual((await store.exportPortable()).records, [valid]);
    const before = await disk();
    await assert.rejects(store.importPortable(envelope(field, version, [invalid]), { replace: true }), error);
    assert.deepEqual(await disk(), before);
  });
}
for (const version of [undefined, 0]) for (const populated of [false, true]) {
  test(`both arrays schema ${version ?? 'absent'} with ${populated ? 'distinct' : 'empty'} records retain ignored questions bound`, async t => {
    const { store, disk } = await fixture(t);
    const records = populated ? [record('chosen')] : [];
    const questions = Array.from({ length: 250 }, (_, index) => record(`ignored-${index}`));
    const input = { ...envelope('records', version, records), questions };
    assert.equal((await store.importPortable(input)).imported, records.length);
    assert.deepEqual((await store.exportPortable()).records, records);
    const before = await disk();
    await assert.rejects(store.importPortable({ ...input, questions: [...questions, record('ignored-extra')] }), /array exceeds 250 entries/);
    assert.deepEqual(await disk(), before);
  });
}
test('public direct history dispatcher rejects nonfinite tags without disk changes', async t => {
  const { store, disk } = await fixture(t);
  await store.append({ question: 'Saved?', evidence_pin: { revision: 'saved' } });
  const before = await disk();
  // These JavaScript values are deliberately passed directly: JSON maps them to null.
  for (const schema_version of [NaN, Infinity, -Infinity]) {
    await assert.rejects(importHistoryRecords({ schema_version, records: [] }, store), /Unsupported history import schema version/);
    assert.deepEqual(await disk(), before);
  }
});

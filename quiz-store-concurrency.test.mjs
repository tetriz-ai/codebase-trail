// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createQuizStore, QuizStoreLimitError } from './quiz-store.mjs';

const question = (id) => ({ question: `Which boundary owns ${id}?`, choices: ['api', 'worker'], answer: 'api', evidence_pin: { revision: 'fixture', id } });
async function owners(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'history-owners-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'history.json');
  const a = createQuizStore({ filePath, ...options }); const b = createQuizStore({ filePath, ...options });
  await a.initialize(); await b.initialize();
  return { a, b, filePath, directory };
}

test('independent owners preserve sequential successful writes and refresh reads', async (t) => {
  const { a, b } = await owners(t);
  assert.equal((await a.append(question('one'))).created, true);
  assert.equal((await b.append(question('two'))).created, true);
  assert.equal((await a.list()).length, 2);
  assert.equal((await b.exportPortable()).records.length, 2);
});

test('concurrent owners deduplicate and enforce capacity against the latest committed document', async (t) => {
  const { a, b, filePath } = await owners(t, { maxRecords: 2 });
  const duplicates = await Promise.all([a.append(question('same')), b.append(question('same'))]);
  assert.equal(duplicates.filter((result) => result.created).length, 1);
  const additions = await Promise.allSettled([a.append(question('two')), b.append(question('three'))]);
  assert.equal(additions.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(additions.find((result) => result.status === 'rejected').reason instanceof QuizStoreLimitError);
  assert.equal((await createQuizStore({ filePath }).list()).length, 2);
});

test('directory aliases and POSIX file symlinks coordinate the same durable history', async (t) => {
  const { a, filePath, directory } = await owners(t);
  await symlink(directory, join(directory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform !== 'win32') await symlink(filePath, join(directory, 'linked.json'), 'file');
  const b = createQuizStore({ filePath: join(directory, 'alias', 'history.json') });
  const c = createQuizStore({ filePath: process.platform === 'win32' ? filePath : join(directory, 'linked.json') });
  await b.initialize(); await c.initialize();
  await Promise.all([a.append(question('one')), b.append(question('two')), c.append(question('three'))]);
  assert.equal((await a.list()).length, 3);
});

test('separate processes preserve every successful append', async (t) => {
  const { a, filePath } = await owners(t);
  const script = `import { createQuizStore } from './quiz-store.mjs';
const store = createQuizStore({ filePath: process.argv[1] });
await store.initialize();
for (let index = 0; index < 8; index++) {
  await store.append({ question: 'Question ' + process.argv[2] + index, evidence_pin: { revision: 'fixture', id: process.argv[2] + index } });
}
console.log('8 writes completed');`;
  const run = promisify(execFile);
  const results = await Promise.all(['a', 'b'].map((id) => run(process.execPath, ['--import', './scripts/test-safety.mjs', '--input-type=module', '-e', script, filePath, id], { timeout: 15_000 })));
  assert.ok(results.every(({ stdout }) => stdout === '8 writes completed\n'));
  assert.equal((await a.list()).length, 16);
});

test('a stale owner cannot roll back another writer through a rejected import', async (t) => {
  const { a, b, filePath, directory } = await owners(t, { maxRecords: 1 });
  await a.append(question('kept'));
  const sourcePath = join(directory, 'source.json');
  const source = createQuizStore({ filePath: sourcePath });
  await source.append(question('incoming'));
  const incoming = await source.exportPortable();
  const bytes = await readFile(filePath);
  await assert.rejects(b.importPortable(incoming), QuizStoreLimitError);
  assert.deepEqual(await readFile(filePath), bytes);
  incoming.records.push({ malformed: true });
  await assert.rejects(b.importPortable(incoming));
  assert.deepEqual(await readFile(filePath), bytes);
  assert.equal((await b.list())[0].question, question('kept').question);
  assert.ok((await readdir(directory)).some((name) => name.includes('.pre-import-')));
});

for (const owner of [{ token: 'live-fixture-owner', pid: process.pid }, { token: 'interrupted-fixture-owner', pid: 2147483647 }, null]) {
  test(`a ${owner?.token || 'partially created'} lock times out without deleting ownership or history`, async (t) => {
    const { a, filePath } = await owners(t);
    await a.append(question('kept'));
    const primary = await readFile(filePath); const backup = await readFile(`${filePath}.bak`);
    await mkdir(`${filePath}.lock`);
    if (owner) await writeFile(`${filePath}.lock/owner.json`, JSON.stringify(owner));
    const started = Date.now();
    await assert.rejects(a.append(question('blocked')), (error) => error.code === 'history_store_busy' && /stop every Codebase Trail process/.test(error.message));
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(await readFile(filePath), primary);
    assert.deepEqual(await readFile(`${filePath}.bak`), backup);
    assert.deepEqual(await readdir(`${filePath}.lock`), owner ? ['owner.json'] : []);
    if (owner) assert.deepEqual(JSON.parse(await readFile(`${filePath}.lock/owner.json`)), owner);
  });
}

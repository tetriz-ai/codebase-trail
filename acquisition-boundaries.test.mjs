// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalArchitectureSnapshot, planArchitectureArchiveBatches } from './server.mjs';
import { LocalGitSourceProvider } from './providers/source/local-git.mjs';

function repository(t, entries) {
  const checkout = mkdtempSync(join(tmpdir(), 'git-evidence-'));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  const git = (args, input) => execFileSync('git', ['-C', checkout, ...args], { input, encoding: 'utf8' });
  git(['init', '-q']);
  for (const [path, content] of entries) {
    const oid = git(['hash-object', '-w', '--stdin'], content).trim();
    git(['update-index', '-z', '--index-info'], Buffer.concat([Buffer.from(`100644 ${oid}\t`), Buffer.from(path), Buffer.from([0])]));
  }
  const tree = git(['write-tree']).trim();
  const revision = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-m', 'Synthetic evidence']).trim();
  git(['update-ref', 'HEAD', revision]);
  return { checkout, revision, provider: new LocalGitSourceProvider({ checkout }) };
}
async function limits(values, run) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { Object.assign(process.env, values); return await run(); }
  finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
test('snapshot ignores archive attributes and acquires exact export-subst and export-ignore blobs', async t => {
  const source = 'export const revision = "$Format:%H$";\n';
  const { checkout, revision } = repository(t, [['.gitattributes', '*.js export-subst export-ignore\n'], ['stamp.js', source]]);
  const snapshot = await loadLocalArchitectureSnapshot('fixture/attributes', checkout);
  assert.equal(snapshot.revision, revision); assert.equal(snapshot.tree_complete, true);
  assert.deepEqual(snapshot.files, [{ path: 'stamp.js', content: source, complete: true, redacted: false }]);
  assert.deepEqual(snapshot.omissions, []);
});
test('snapshot ignores export-subst transformations without export-ignore', async t => {
  const source = 'export const revision = "$Format:%H$";\n';
  const { checkout } = repository(t, [['.gitattributes', '*.js export-subst\n'], ['stamp.js', source]]);
  const snapshot = await loadLocalArchitectureSnapshot('fixture/substitution', checkout);
  assert.equal(snapshot.files[0].content, source); assert.equal(snapshot.tree_complete, true);
});
for (const boundary of ['snapshot', 'provider']) test(`${boundary} preserves literal path identities and committed bodies`, async t => {
  const paths = [':colon.js', 'back\\slash.js', 'back/slash.js', '[bracket].js', '\uFEFFshort.js', 'café.js', 'real-�.js', 'line\nbreak.js', 'tab\tfile.js', 'quote".js', `nested/é/${'z'.repeat(110)}\nlong.js`];
  const entries = paths.map((path, index) => [path, `export const n = ${index};\n`]);
  const { checkout, revision, provider } = repository(t, entries);
  writeFileSync(join(checkout, 'café.js'), 'dirty'); writeFileSync(join(checkout, 'untracked.js'), 'untracked');
  if (boundary === 'provider') {
  assert.deepEqual((await provider.listFiles({ revision })).sort(), [...paths].sort());
  for (const [path, content] of entries) assert.equal(await provider.readFile({ revision, path }), content, path);
  } else {
  const snapshot = await loadLocalArchitectureSnapshot('fixture/literal', checkout);
  assert.deepEqual(snapshot.files.map(({ path, content }) => [path, content]).sort(), [...entries].sort());
  assert.equal(snapshot.tree_complete, true); assert.deepEqual(snapshot.omissions, []);
  }
  for (const path of ['../escape.js', '/absolute.js', 'nul\0.js', 'a/../escape.js']) await assert.rejects(provider.readFile({ revision, path }), /relative|escape/);
});
test('local Git provider rejects invalid UTF-8 filename bytes', async t => {
  const { provider, revision } = repository(t, [[Buffer.concat([Buffer.from('bad-'), Buffer.from([255]), Buffer.from('.js')]), 'fixture']]);
  await assert.rejects(provider.listFiles({ revision }), /UTF-8.*filename|filename.*UTF-8/);
});
test('empty committed tree is a complete empty snapshot and provider listing', async t => {
  const { checkout, revision, provider } = repository(t, []);
  const snapshot = await loadLocalArchitectureSnapshot('fixture/empty', checkout);
  assert.deepEqual(snapshot.files, []); assert.deepEqual(snapshot.omissions, []); assert.equal(snapshot.tree_complete, true);
  assert.deepEqual(await provider.listFiles({ revision }), []);
});
for (const key of ['ARCHITECTURE_MAX_FILES', 'ARCHITECTURE_MAX_BYTES', 'ARCHITECTURE_MAX_FILE_BYTES']) {
  for (const value of ['invalid', 'NaN', 'Infinity', '-Infinity', '1.5', '0', '-1', '', ' ', '9007199254740992']) test(`invalid acquisition policy ${key}=${JSON.stringify(value)} fails explicitly`, async t => {
    const { checkout } = repository(t, [['entry.js', 'x']]);
    await limits({ [key]: value }, () => assert.rejects(loadLocalArchitectureSnapshot('fixture/invalid-policy', checkout), /positive safe integer/));
  });
}
for (const count of [1, 2, 3]) test(`acquisition file cap includes ${count} candidates at limit two`, async t => {
  const entries = ['a.js', 'b\nfile.js', `${'c'.repeat(110)}.js`].slice(0, count).map(path => [path, 'x']);
  const { checkout } = repository(t, entries);
  const snapshot = await limits({ ARCHITECTURE_MAX_FILES: '2' }, () => loadLocalArchitectureSnapshot('fixture/file-cap', checkout));
  assert.equal(snapshot.files.length, Math.min(count, 2)); assert.equal(snapshot.tree_complete, count <= 2);
  assert.deepEqual(snapshot.omissions, count > 2 ? [{ path: entries[2][0], reason: 'architecture_file_cap' }] : []);
});
for (const bytes of [1, 2, 3]) test(`raw per-file byte cap accepts ${bytes} bytes at limit two`, async t => {
  const { checkout } = repository(t, [['é.js', bytes === 2 ? 'é' : 'x'.repeat(bytes)]]);
  const snapshot = await limits({ ARCHITECTURE_MAX_FILE_BYTES: '2' }, () => loadLocalArchitectureSnapshot('fixture/file-bytes', checkout));
  assert.equal(snapshot.files.length, bytes <= 2 ? 1 : 0); assert.equal(snapshot.tree_complete, bytes <= 2);
  assert.deepEqual(snapshot.omissions, bytes <= 2 ? [] : [{ path: 'é.js', reason: 'architecture_file_too_large' }]);
});
for (const cap of [3, 4, 5]) test(`total raw byte boundary uses byte limit ${cap}`, async t => {
  const { checkout } = repository(t, [['a.js', 'é'], ['b.js', 'é']]);
  const snapshot = await limits({ ARCHITECTURE_MAX_BYTES: String(cap) }, () => loadLocalArchitectureSnapshot('fixture/total-raw', checkout));
  assert.equal(snapshot.files.length, cap < 4 ? 1 : 2); assert.equal(snapshot.tree_complete, cap >= 4);
  assert.deepEqual(snapshot.omissions, cap < 4 ? [{ path: 'b.js', reason: 'architecture_byte_cap' }] : []);
});
for (const key of ['ARCHITECTURE_MAX_FILE_BYTES', 'ARCHITECTURE_MAX_BYTES']) for (const cap of [2, 3, 4]) test(`materialized byte boundary ${key}=${cap}`, async t => {
  const { checkout } = repository(t, [['é.js', Buffer.from([255])]]);
  const snapshot = await limits({ [key]: String(cap) }, () => loadLocalArchitectureSnapshot('fixture/materialized', checkout));
  assert.equal(snapshot.files.length, cap < 3 ? 0 : 1); assert.equal(snapshot.tree_complete, cap >= 3);
  assert.deepEqual(snapshot.omissions, cap < 3 ? [{ path: 'é.js', reason: key.endsWith('FILE_BYTES') ? 'architecture_file_too_large' : 'architecture_byte_cap' }] : []);
  if (cap >= 3) assert.equal(snapshot.files[0].content, '�');
});
test('acquisition validates changed policy before reusing a cached revision', async t => {
  const { checkout } = repository(t, [['a.js', 'x'], ['b.js', 'x']]);
  assert.equal((await loadLocalArchitectureSnapshot('fixture/policy-cache', checkout)).files.length, 2);
  const bounded = await limits({ ARCHITECTURE_MAX_FILES: '1' }, () => loadLocalArchitectureSnapshot('fixture/policy-cache', checkout));
  assert.equal(bounded.files.length, 1); assert.equal(bounded.tree_complete, false);
  await limits({ ARCHITECTURE_MAX_FILES: 'NaN' }, () => assert.rejects(loadLocalArchitectureSnapshot('fixture/policy-cache', checkout), /positive safe integer/));
});
for (const cap of [5, 6, 7]) test(`total materialized bytes across files respect limit ${cap}`, async t => {
  const { checkout } = repository(t, [['a.js', Buffer.from([255])], ['b.js', Buffer.from([255])]]);
  const snapshot = await limits({ ARCHITECTURE_MAX_BYTES: String(cap) }, () => loadLocalArchitectureSnapshot('fixture/materialized-total', checkout));
  assert.equal(snapshot.files.length, cap < 6 ? 1 : 2); assert.equal(snapshot.tree_complete, cap >= 6);
  assert.deepEqual(snapshot.omissions, cap < 6 ? [{ path: 'b.js', reason: 'architecture_byte_cap' }] : []);
});

for (const path of ['\uFEFFshort.js', `\uFEFF${'a'.repeat(110)}.js`]) test(`first and sole provider filename retains BOM with length ${path.length}`, async t => {
  const content = 'export const exact = true;\n';
  const { checkout, revision, provider } = repository(t, [[path, content]]);
  assert.deepEqual(await provider.listFiles({ revision }), [path]);
  assert.equal(await provider.readFile({ revision, path }), content);
  const snapshot = await loadLocalArchitectureSnapshot('fixture/sole-bom', checkout);
  assert.deepEqual(snapshot.files, [{ path, content, complete: true, redacted: false }]);
  assert.equal(snapshot.tree_complete, true); assert.deepEqual(snapshot.omissions, []);
});
for (const [count, lengths] of [[199, [199]], [200, [200]], [201, [200, 1]], [401, [200, 200, 1]]]) test(`Git object batches preserve all ${count} entries in order`, () => {
  const files = Array.from({ length: count }, (_, index) => ({ path: `${index}.js`, size: 1 }));
  const batches = planArchitectureArchiveBatches(files);
  assert.deepEqual(batches.map(batch => batch.length), lengths);
  assert.deepEqual(batches.flat(), files);
  assert.equal(new Set(batches.flat().map(file => file.path)).size, count);
});
test('committed zero-byte file remains present in a complete snapshot', async t => {
  const { checkout } = repository(t, [['empty.js', '']]);
  const snapshot = await loadLocalArchitectureSnapshot('fixture/empty-file', checkout);
  assert.deepEqual(snapshot.files, [{ path: 'empty.js', content: '', complete: true, redacted: false }]);
  assert.equal(snapshot.tree_complete, true); assert.deepEqual(snapshot.omissions, []);
});
test('simultaneous acquisition caps retain file-count diagnostic precedence', async t => {
  const { checkout } = repository(t, [['a.js', 'x'], ['b.js', 'x']]);
  const snapshot = await limits({ ARCHITECTURE_MAX_FILES: '1', ARCHITECTURE_MAX_BYTES: '1' }, () => loadLocalArchitectureSnapshot('fixture/both-caps', checkout));
  assert.deepEqual(snapshot.files, [{ path: 'a.js', content: 'x', complete: true, redacted: false }]);
  assert.equal(snapshot.tree_complete, false);
  assert.deepEqual(snapshot.omissions, [{ path: 'b.js', reason: 'architecture_file_cap' }]);
});

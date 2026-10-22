// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify, inspect } from 'node:util';

const oid = 'b'.repeat(40);
let body; let listedSize = 1; let request; let options; let processFailure;
const fakeExecFile = () => { throw new Error('Unexpected callback execution'); };
fakeExecFile[promisify.custom] = (_command, args, suppliedOptions) => {
  if (args.includes('rev-parse')) return Promise.resolve({ stdout: 'a'.repeat(40) });
  if (args.includes('ls-tree')) return Promise.resolve({ stdout: Buffer.from(`100644 blob ${oid}       ${listedSize}\tentry.js\0`) });
  if (args.includes('cat-file')) {
    options = suppliedOptions;
    const pending = processFailure ? Promise.reject(processFailure === true ? new Error('controlled Git failure') : processFailure) : Promise.resolve({ stdout: Buffer.from(body) });
    pending.child = { stdin: { on() {}, end(value) { request = value; } } };
    return pending;
  }
  return Promise.resolve({ stdout: '' });
};
const originalExecFile = childProcess.execFile;
childProcess.execFile = fakeExecFile;
syncBuiltinESMExports();
const { loadLocalArchitectureSnapshot } = await import('./server.mjs');
childProcess.execFile = originalExecFile;
syncBuiltinESMExports();

for (const [index, malformed] of [
  '', `${oid} blob 1`, `${oid} blob 1\n`, `${oid} blob 1\nx`, `${oid} blob 1\nxX`,
  `${oid} blob 2\nxx\n`, `${oid} tree 1\nx\n`, `${'c'.repeat(40)} blob 1\nx\n`,
  `${oid} blob -1\n`, `${oid} blob 1.5\nx\n`, `${oid} blob 9007199254740992\n`,
  `${oid} blob 1\nx\ntrailing`,
  Buffer.concat([Buffer.from([0xe2]), Buffer.from(`${oid.slice(1)} blob 1\nx\n`)]),
].entries()) test(`rejects malformed blob framing ${index} without publishing snapshot evidence`, async () => {
  body = malformed;
  await assert.rejects(loadLocalArchitectureSnapshot(`fixture/framing-${index}`, '/tmp/synthetic-checkout'), /framing/);
});
test('missing blob yields an explicit incomplete snapshot', async () => {
  body = `${oid} missing\n`;
  const snapshot = await loadLocalArchitectureSnapshot('fixture/missing-blob', '/tmp/synthetic-checkout');
  assert.deepEqual(snapshot.files, []); assert.equal(snapshot.tree_complete, false);
  assert.deepEqual(snapshot.omissions, [{ path: 'entry.js', reason: 'architecture_archive_missing_blob' }]);
});
test('bounded blob batch reads exact body and sends only pinned object IDs', async () => {
  body = `${oid} blob 1\nx\n`;
  const snapshot = await loadLocalArchitectureSnapshot('fixture/blob-control', '/tmp/synthetic-checkout');
  assert.deepEqual(snapshot.files, [{ path: 'entry.js', content: 'x', complete: true, redacted: false }]);
  assert.equal(snapshot.tree_complete, true); assert.deepEqual(snapshot.omissions, []);
  assert.equal(request, `${oid}\n`); assert.equal(options.encoding, 'buffer');
  assert.equal(options.timeout, 120_000); assert.equal(options.maxBuffer, 80 * 1024 * 1024);
});
test('blob process failure rejects acquisition and allows a subsequent retry', async () => {
  processFailure = true;
  await assert.rejects(loadLocalArchitectureSnapshot('fixture/blob-retry', '/tmp/synthetic-checkout'), /blob read failed/);
  processFailure = false; body = `${oid} blob 1\nx\n`;
  assert.equal((await loadLocalArchitectureSnapshot('fixture/blob-retry', '/tmp/synthetic-checkout')).files[0].content, 'x');
});

test('blob failure retains a bounded diagnostic cause without raw subprocess output', async () => {
  const original = Object.assign(new Error('process failed'), {
    stderr: 'bounded diagnostic '.padEnd(800, 'x') + 'PRIVATE_STDERR_TAIL',
    stdout: 'PRIVATE_SOURCE_PAYLOAD',
    cause: new Error('PRIVATE_NESTED_CAUSE'),
  });
  processFailure = original;
  try {
    await assert.rejects(loadLocalArchitectureSnapshot('fixture/bounded-cause', '/tmp/synthetic-checkout'), error => {
      assert.match(error.message, /^Architecture blob read failed/);
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.message, original.stderr.slice(0, 500));
      assert.equal(error.cause.stdout, undefined);
      assert.equal(error.cause.stderr, undefined);
      assert.equal(error.cause.cause, undefined);
      assert.doesNotMatch(inspect(error), /PRIVATE_/);
      return true;
    });
  } finally { processFailure = false; }
});

test('zero-byte blob framing preserves an empty file', async () => {
  listedSize = 0; body = `${oid} blob 0\n\n`;
  try {
    const snapshot = await loadLocalArchitectureSnapshot('fixture/zero-blob', '/tmp/synthetic-checkout');
    assert.deepEqual(snapshot.files, [{ path: 'entry.js', content: '', complete: true, redacted: false }]);
    assert.equal(snapshot.tree_complete, true); assert.deepEqual(snapshot.omissions, []);
  } finally { listedSize = 1; }
});

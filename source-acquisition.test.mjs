// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';

const calls = []; let server;
before(async () => {
  const original = childProcess.execFile;
  const injected = (command, args, options, callback) => {
    if (command !== 'gh') return original(command, args, options, callback);
    calls.push(args);
    const output = args[0] === 'api' ? 'fixture-author\n' : JSON.stringify([
      { number: 1, changedFiles: 0 }, { number: 2, changedFiles: 1 }, { number: 3, changedFiles: 2 }, { number: 4, changedFiles: -1 }, { number: 5 },
    ].map((pr) => ({ ...pr, title: 'Synthetic', mergedAt: '2026-01-01T00:00:00Z', url: 'https://example.invalid/pull' })));
    queueMicrotask(() => callback(null, output, ''));
  };
  const execute = promisify(original);
  injected[promisify.custom] = (...args) => args[0] === 'gh'
    ? new Promise((resolve, reject) => injected(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })))
    : execute(...args);
  childProcess.execFile = injected; syncBuiltinESMExports();
  try {
    server = await import('./server.mjs');
  } finally { childProcess.execFile = original; syncBuiltinESMExports(); }
});

test('architecture snapshots read committed blobs and exclude dirty tracked and untracked source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'committed-evidence-'));
  const git = (...args) => childProcess.execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q');
    await writeFile(join(directory, 'schema.sql'), 'CREATE TABLE committed(id int);\n');
    git('add', 'schema.sql');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic fixture');
    const revision = git('rev-parse', 'HEAD').trim();
    await writeFile(join(directory, 'schema.sql'), 'CREATE TABLE dirty(id int);\n');
    await writeFile(join(directory, 'untracked.sql'), 'CREATE TABLE untracked(id int);\n');
    const snapshot = await server.loadLocalArchitectureSnapshot('example/repo', directory);
    assert.equal(snapshot.revision, revision);
    assert.deepEqual(snapshot.files.map(({ path, content }) => ({ path, content })), [{ path: 'schema.sql', content: 'CREATE TABLE committed(id int);\n' }]);
    assert.equal(snapshot.tree_complete, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('PR candidates pin signed-in author, merged state, limit and nonempty changed files', async () => {
  const result = await server.loadCandidates();
  assert.equal(result.login, 'fixture-author');
  assert.deepEqual(result.candidates.map(({ number }) => number), [2, 3]);
  assert.deepEqual(calls, [
    ['api', 'user', '--jq', '.login'],
    ['pr', 'list', '--repo', result.repository, '--state', 'merged', '--author', 'fixture-author', '--limit', '50', '--json', 'number,title,mergedAt,url,changedFiles'],
  ]);
});

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

test('headless GitHub sign-in returns a visible device code before authentication completes', async () => {
  const { signInToGitHub } = await import('./launcher.mjs');
  const child = new EventEmitter(); child.stderr = new PassThrough(); child.kill = () => child.emit('exit', 1);
  const login = signInToGitHub((command, args, options) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 4), ['auth', 'login', '--web', '--clipboard']);
    assert.equal(options.env.GH_HOST, 'github.com');
    assert.equal(options.stdio[2], 'pipe');
    return child;
  });
  child.stderr.write('! One-time code (ABCD-1234) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
  assert.deepEqual(await login.ready, { status: 'pending', code: 'ABCD-1234', url: 'https://github.com/login/device' });
  assert.equal(login.state.status, 'pending');
  child.emit('exit', 0);
  assert.equal((await login.completion).status, 'connected');
});

test('explicit init opens setup on later launches while the default opens the app', async () => {
  const { initialPage } = await import('./launcher.mjs');
  assert.equal(initialPage('init', true), '/settings');
  assert.equal(initialPage('start', false), '/settings');
  assert.equal(initialPage('start', true), '/');
  assert.throws(() => initialPage('unknown', true), /Usage/);
});

test('first launch serves setup, rejects cross-origin saves, and opens learning after configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-learning-launcher-'));
  process.env.CODE_LEARNING_HOME = directory;
  const { createLauncher } = await import(`./launcher.mjs?test=${Date.now()}`);
  const server = createLauncher();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const landing = await fetch(base, { redirect: 'manual' });
    assert.equal(landing.status, 302);
    assert.equal(landing.headers.get('location'), '/settings');
    const page = await (await fetch(`${base}/settings`)).text();
    const token = page.match(/const token='([^']+)'/)[1];
    const headers = { origin: base, 'content-type': 'application/json', 'x-code-learning-token': token };
    const modelLookup = { provider: 'openai-compatible', endpoint: 'http://external.example/v1', authMode: 'none', credential: '' };
    const unauthorizedLookup = await fetch(`${base}/api/settings/models`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(modelLookup) });
    assert.equal(unauthorizedLookup.status, 403);
    const invalidLookup = await fetch(`${base}/api/settings/models`, { method: 'POST', headers, body: JSON.stringify(modelLookup) });
    assert.equal(invalidLookup.status, 422);
    assert.match((await invalidLookup.json()).error, /HTTPS/);
    const unauthorizedChecks = await fetch(`${base}/api/settings/checks`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ checkout: process.cwd() }) });
    assert.equal(unauthorizedChecks.status, 403);
    const unauthorizedLogin = await fetch(`${base}/api/settings/github-login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauthorizedLogin.status, 403);
    const sourceChecks = await fetch(`${base}/api/settings/checks`, { method: 'POST', headers, body: JSON.stringify({ checkout: join(directory, 'not-a-repository') }) });
    assert.equal(sourceChecks.status, 200);
    assert.equal((await sourceChecks.json()).checks.find((item) => item.name === 'Source checkout').ok, false);
    const before = await fetch(`${base}/api/settings`, { headers: { 'x-code-learning-token': token } });
    assert.equal((await before.json()).setup, true);
    const config = { version: 1, source: { provider: 'local-git', checkout: process.cwd(), repository: null, hostname: null }, model: { provider: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'local-model', authMode: 'none', apiKeyEnv: null } };
    const hostile = await fetch(`${base}/api/settings`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: JSON.stringify({ config }) });
    assert.equal(hostile.status, 403);
    const saved = await fetch(`${base}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ config }) });
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
    const app = await fetch(base);
    assert.equal(app.status, 200);
    assert.match(await app.text(), /href="\/settings"/);
    const after = await fetch(`${base}/api/settings`, { headers: { 'x-code-learning-token': token } });
    assert.equal((await after.json()).setup, false);
    const broken = { ...config, source: { ...config.source, checkout: join(directory, 'not-a-repository') } };
    const rejected = await fetch(`${base}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ config: broken }) });
    assert.equal(rejected.status, 422);
    assert.equal((await fetch(base)).status, 200, 'a failed change must leave the running app available');
    const persisted = await fetch(`${base}/api/settings`, { headers: { 'x-code-learning-token': token } });
    assert.equal((await persisted.json()).config.source.checkout, process.cwd());
    const alternatives = ['model-a', 'model-b'].map((model) => ({ ...config, model: { ...config.model, model } }));
    const simultaneous = await Promise.all(alternatives.map((candidate) => fetch(`${base}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ config: candidate }) })));
    assert.ok(simultaneous.every((result) => result.status === 200));
    const finalSettings = await (await fetch(`${base}/api/settings`, { headers: { 'x-code-learning-token': token } })).json();
    const appHtml = await (await fetch(base)).text();
    const appToken = appHtml.match(/const apiToken = '([^']+)'/)[1];
    const status = await (await fetch(`${base}/api/status`, { headers: { 'x-code-learning-token': appToken } })).json();
    assert.equal(status.model_provider.model, finalSettings.config.model.model, 'concurrent saves must leave the running app in sync with disk');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
    delete process.env.CODE_LEARNING_HOME;
    delete process.env.CODE_LEARNING_CONFIG;
    delete process.env.CODE_LEARNING_STORE_PATH;
    delete process.env.CODE_LEARNING_CACHE_DIR;
  }
});

test('CLI help exits successfully before profiles, helpers, listeners or browser opening', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'launcher-help-'));
  const tripwire = join(directory, 'tripwire.mjs');
  await writeFile(tripwire, `import fs from 'node:fs';
import promises from 'node:fs/promises';
import child from 'node:child_process';
import { Server } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
// Safety has already created a temporary HOME and fake helper profiles.
for (const name of ['CODE_LEARNING_HOME', 'CODE_LEARNING_CONFIG', 'CODEBASE_TRAIL_HOME', 'CODEBASE_TRAIL_CONFIG']) delete process.env[name];
const fail = () => { throw new Error('HELP_SIDE_EFFECT'); };
for (const name of ['existsSync', 'readFileSync', 'statSync']) { const original = fs[name]; fs[name] = (path, ...args) => { if (String(path).startsWith(process.env.HOME)) fail(); return original(path, ...args); }; }
for (const name of ['readFile', 'stat', 'access', 'readdir']) { const original = promises[name]; promises[name] = (path, ...args) => { if (String(path).startsWith(process.env.HOME)) fail(); return original(path, ...args); }; }
child.spawn = fail; child.execFile = fail; Server.prototype.listen = fail;
syncBuiltinESMExports();
`);
  const expected = 'Usage: codebase-trail [start|init]\n\nstart  Open practice, or setup when no settings are saved.\ninit   Open setup.\n\nRequires Node.js 20+ and Git. Configure the source and model in Settings.\nSet CODEBASE_TRAIL_NO_BROWSER=1 to print the URL without opening a browser.\n';
  try {
    const outcomes = [];
    for (const args of [['--help'], ['start', '--help'], ['init', '--help']]) {
      try {
        const stdout = execFileSync(process.execPath, ['--import', './scripts/test-safety.mjs', '--import', tripwire, './launcher.mjs', ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
        outcomes.push({ args, stdout, status: 0 });
      } catch (error) { outcomes.push({ args, status: error.status, stderr: error.stderr }); }
    }
    assert.deepEqual(outcomes, [['--help'], ['start', '--help'], ['init', '--help']].map(args => ({ args, stdout: expected, status: 0 })));
    for (const args of [['unknown'], ['start', '--unknown'], ['init', 'extra'], ['--help', 'extra'], ['start', '--help', 'extra'], ['start', 'init']]) assert.throws(() => execFileSync(process.execPath, ['--import', './scripts/test-safety.mjs', '--import', tripwire, './launcher.mjs', ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 2 && error.stdout === '' && error.stderr === 'Usage: codebase-trail [init]\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI announces a reachable bound ephemeral setup URL for default, start and init', async () => {
  const { spawn } = await import('node:child_process');
  for (const args of [[], ['start'], ['init']]) {
    const child = spawn(process.execPath, ['--import', './scripts/test-safety.mjs', './launcher.mjs', ...args], { env: { ...process.env, PORT: '0', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      const url = await new Promise((resolve, reject) => {
        let output = ''; let stderr = '';
        const timer = setTimeout(() => reject(new Error(`CLI did not announce URL: ${stderr}`)), 10_000);
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.stdout.on('data', (chunk) => {
          output += chunk;
          const match = output.match(/Codebase Trail: (http:\/\/127\.0\.0\.1:\d+\/settings)/);
          if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`CLI exited early: ${stderr}`)); });
      });
      assert.notEqual(new URL(url).port, '0');
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Save and start learning/);
      const landing = await fetch(new URL('/', url), { redirect: 'manual' });
      assert.equal(landing.status, 302);
      assert.equal(landing.headers.get('location'), '/settings');
    } finally { child.kill(); await exited; }
  }
});

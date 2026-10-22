// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSettings, settingsPaths, settingsSnapshot, dependencyChecks, detectSources, discoverModels, githubRepositoryFromRemote } from './settings-store.mjs';

test('new settings paths use Codebase Trail and existing settings remain discoverable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codebase-trail-paths-'));
  try {
    const options = { platformName: 'linux', homeDirectory: home };
    const profile = join(home, '.config');
    const modern = join(profile, 'codebase-trail');
    const legacy = join(profile, 'tetriz', 'code-learning');
    assert.equal(settingsPaths({}, options).directory, modern);
    assert.equal(settingsPaths({ APPDATA: join(home, 'Roaming') }, { platformName: 'win32', homeDirectory: home }).directory, join(home, 'Roaming', 'Codebase Trail'));
    assert.equal(settingsPaths({}, { platformName: 'darwin', homeDirectory: home }).directory, join(home, 'Library', 'Application Support', 'Codebase Trail'));
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'settings.json'), '{}');
    assert.equal(settingsPaths({}, options).directory, legacy);
    await mkdir(modern, { recursive: true });
    await writeFile(join(modern, 'settings.json'), '{}');
    assert.equal(settingsPaths({}, options).directory, modern);
    assert.equal(settingsPaths({ CODEBASE_TRAIL_HOME: home, CODEBASE_TRAIL_CONFIG: join(home, 'custom.json') }, options).config, join(home, 'custom.json'));
    assert.equal(settingsPaths({ CODE_LEARNING_HOME: home }, options).directory, home);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('first-run settings persist without exposing credentials and can be edited', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-learning-settings-'));
  try {
    const paths = settingsPaths({ CODE_LEARNING_HOME: directory });
    const first = await settingsSnapshot(paths, {});
    assert.equal(first.exists, false);
    const config = { version: 1, source: { provider: 'local-git', checkout: directory, repository: null, hostname: null }, model: { provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'test-model', apiKeyEnv: 'OPENAI_API_KEY' } };
    await assert.rejects(saveSettings(paths, { config }, {}), /OPENAI_API_KEY is required/);
    await saveSettings(paths, { config, credentials: { OPENAI_API_KEY: 'secret-for-test' } }, {});
    const saved = await settingsSnapshot(paths, {});
    assert.equal(saved.exists, true);
    assert.equal(saved.public.model.credential.configured, true);
    assert.equal(JSON.stringify(saved.public).includes('secret-for-test'), false);
    assert.equal((await readFile(paths.state, 'utf8')).includes('secret-for-test'), true);
    if (process.platform !== 'win32') assert.equal((await stat(paths.state)).mode & 0o077, 0);
    config.model.model = 'another-model';
    await saveSettings(paths, { config }, {});
    const edited = await settingsSnapshot(paths, {});
    assert.equal(edited.config.model.model, 'another-model');
    assert.equal(edited.credentials.OPENAI_API_KEY, 'secret-for-test');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('settings reject unrelated secret fields and invalid endpoints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-learning-settings-'));
  try {
    const paths = settingsPaths({ CODE_LEARNING_HOME: directory });
    const config = { version: 1, source: { provider: 'local-git', checkout: directory }, model: { provider: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'local', authMode: 'none', apiKeyEnv: null } };
    await assert.rejects(saveSettings(paths, { config, credentials: { UNRELATED_KEY: 'secret' } }, {}), /does not match/);
    config.model.endpoint = 'http://external.example/v1';
    await assert.rejects(saveSettings(paths, { config }, {}), /HTTPS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('saved settings control the CLI even when config environment variables exist, and unused keys are removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'code-learning-settings-'));
  try {
    const paths = settingsPaths({ CODE_LEARNING_HOME: directory });
    const env = { CODE_LEARNING_MODEL: 'old-shell-model' };
    const config = { version: 1, source: { provider: 'local-git', checkout: directory }, model: { provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'saved-model', apiKeyEnv: 'OPENAI_API_KEY' } };
    await saveSettings(paths, { config, credentials: { OPENAI_API_KEY: 'secret-for-test' } }, env);
    assert.equal((await settingsSnapshot(paths, env)).config.model.model, 'saved-model');
    config.model = { provider: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'local', apiKeyEnv: null, authMode: 'none' };
    await saveSettings(paths, { config }, env);
    assert.deepEqual((await settingsSnapshot(paths, env)).credentials, {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dependency report distinguishes optional GitHub CLI from required parser and Git', async () => {
  const checks = await dependencyChecks({ source: { provider: 'local-git', checkout: process.cwd() } });
  assert.ok(checks.some((item) => item.name === 'Native parsers' && item.ok));
  assert.equal(checks.find((item) => item.name === 'gh').required, false);
  assert.equal(checks.find((item) => item.name === 'git').required, true);
});

test('missing npm, Git, and native parsers produce actionable checks without a startup crash', async () => {
  const checks = await dependencyChecks({ source: { provider: 'local-git', checkout: '/missing/checkout' } }, {
    checkParsers: async () => { throw new Error('native binary unavailable'); },
    runCommand: async (name) => {
      if (['npm', 'cmd.exe', 'git'].includes(name)) throw new Error('command unavailable');
      return { stdout: 'gh version' };
    },
  });
  assert.equal(checks.find((item) => item.name === 'npm').ok, false);
  assert.equal(checks.find((item) => item.name === 'npm').required, false);
  assert.match(checks.find((item) => item.name === 'npm').detail, /Install Node.js/);
  assert.equal(checks.find((item) => item.name === 'Native parsers').ok, false);
  const parserDetail = checks.find((item) => item.name === 'Native parsers').detail;
  assert.match(parserDetail, /npm ci --include=optional/);
  assert.match(parserDetail, /Codebase Trail source checkout/);
  assert.match(parserDetail, /docs\/install\.md/);
  assert.doesNotMatch(parserDetail, /npm install -g codebase-trail/);
  if (process.platform === 'win32' && process.arch === 'arm64') assert.match(parserDetail, /x64 Node.js/);
  assert.equal(checks.find((item) => item.name === 'git').ok, false);
  assert.equal(checks.find((item) => item.name === 'Source checkout').ok, false);
});

test('GitHub source requires authentication and repository access before activation', async () => {
  const source = { provider: 'github-gh', repository: 'example/repo', hostname: 'github.com' };
  const unauthenticated = await dependencyChecks({ source }, { verifyRepository: true, runCommand: async (name, args) => {
    if (name === 'gh' && args[0] === 'auth') throw new Error('not signed in');
    return { stdout: `${name} version` };
  } });
  assert.equal(unauthenticated.find((item) => item.name === 'GitHub authentication').ok, false);
  assert.equal(unauthenticated.find((item) => item.name === 'GitHub authentication').required, true);
  const inaccessible = await dependencyChecks({ source }, { verifyRepository: true, runCommand: async (name, args) => {
    if (name === 'gh' && args[0] === 'repo') throw new Error('not found');
    return { stdout: `${name} version` };
  } });
  assert.equal(inaccessible.find((item) => item.name === 'GitHub repository access').ok, false);
});

test('a local checkout detects its GitHub remote and reports optional PR access', async () => {
  assert.equal(githubRepositoryFromRemote('git@github.com:example-org/app.git'), 'example-org/app');
  assert.equal(githubRepositoryFromRemote('https://github.com/example-org/app'), 'example-org/app');
  assert.equal(githubRepositoryFromRemote('https://example.com/example-org/app'), null);
  const source = { provider: 'local-git', checkout: '/work/core' };
  const runCommand = async (name, args) => {
    if (name === 'git' && args[2] === 'remote') return { stdout: 'git@github.com:example-org/app.git\n' };
    if (name === 'gh' && args[0] === 'auth') throw new Error('not signed in');
    return { stdout: `${name} version` };
  };
  const checks = await dependencyChecks({ source }, { verifyRepository: true, runCommand });
  assert.equal(checks.find((item) => item.name === 'GitHub remote').detail, 'example-org/app');
  assert.equal(checks.find((item) => item.name === 'GitHub authentication').required, false);
  assert.equal(checks.find((item) => item.name === 'GitHub authentication').ok, false);
  assert.equal(checks.find((item) => item.name === 'Source checkout').ok, true);
});

test('source suggestions include current checkout, GitHub repositories, and saved custom values', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'code-learning-discovery-'));
  try {
    await mkdir(join(homeDirectory, 'repo-one', '.git'), { recursive: true });
    await mkdir(join(homeDirectory, 'projects', 'repo-two', '.git'), { recursive: true });
    const sources = await detectSources({ directory: '/work/project', homeDirectory, savedSource: { checkout: '/custom/repo', repository: 'custom/repo' }, runCommand: async (name, args) => {
      if (name === 'git') return { stdout: '/work/project\n' };
      if (args[1] === 'view') return { stdout: '{"nameWithOwner":"current/repo"}' };
      return { stdout: '[{"nameWithOwner":"other/repo"}]' };
    } });
    for (const checkout of ['/custom/repo', '/work/project', join(homeDirectory, 'repo-one'), join(homeDirectory, 'projects', 'repo-two')]) assert.ok(sources.checkouts.includes(checkout));
    assert.equal(sources.currentCheckout, '/work/project');
    assert.deepEqual(sources.repositories, ['current/repo', 'custom/repo', 'other/repo']);
  } finally { await rm(homeDirectory, { recursive: true, force: true }); }
});

test('model discovery lists exact IDs without returning credentials and gives actionable failures', async () => {
  let sent;
  const result = await discoverModels({ provider: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1', authMode: 'bearer', credential: 'secret', fetcher: async (url, options) => {
    sent = { url, options };
    return new Response(JSON.stringify({ data: [{ id: 'vendor/model' }, { id: 'vendor/model' }] }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(result.models, ['vendor/model']);
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/models');
  assert.equal(sent.options.headers.authorization, 'Bearer secret');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  await assert.rejects(discoverModels({ provider: 'openai-compatible', endpoint: 'http://example.com/v1', authMode: 'none', credential: '' }), /HTTPS/);
  await assert.rejects(discoverModels({ provider: 'openai-compatible', endpoint: 'https://example.com/v1', authMode: 'bearer', credential: 'bad', fetcher: async () => new Response('', { status: 401 }) }), /rejected the credential/);
});

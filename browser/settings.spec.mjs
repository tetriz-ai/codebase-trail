// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('first-run browser setup opens learning and Settings remains reachable', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'code-learning-first-run-'));
  process.env.CODE_LEARNING_HOME = directory;
  const { createLauncher } = await import(`../launcher.mjs?first-run=${Date.now()}`);
  const server = createLauncher();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.route('**/api/architecture/practice/prefetch', (route) => route.fulfill({ status: 204 }));
    let releaseSuggestions;
    const suggestionsReady = new Promise((resolve) => { releaseSuggestions = resolve; });
    await page.route(`${base}/api/settings/sources`, async (route) => { await suggestionsReady; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checkouts: ['/other/one', process.cwd(), '/other/two'], currentCheckout: process.cwd(), repositories: [] }) }); });
    await page.route(`${base}/api/settings/checks`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checks: [
      { name: 'Node.js', ok: true, required: true, detail: 'Ready' }, { name: 'Native parsers', ok: true, required: true, detail: 'Ready' }, { name: 'git', ok: true, required: true, detail: 'Ready' }, { name: 'Source checkout', ok: true, required: true, detail: process.cwd() },
      { name: 'GitHub remote', ok: true, required: false, detail: 'fixture/repo' }, { name: 'gh', ok: true, required: false, detail: 'Ready' }, { name: 'GitHub authentication', ok: true, required: false, detail: 'Signed in' }, { name: 'GitHub repository access', ok: true, required: false, detail: 'fixture/repo' },
    ] }) }));
    await page.goto(`${base}/settings`);
    await expect(page).toHaveTitle('Settings · Codebase Trail');
    await expect(page.locator('header .brand-mark svg')).toBeVisible();
    await expect(page.locator('header .brand')).toContainText('Understand the code. Keep up with the changes.');
    await expect(page.locator('#title')).toHaveText('Set up Codebase Trail');
    await expect(page.locator('#back')).toBeHidden();
    await page.locator('#checkout').selectOption('__custom__');
    await page.locator('#customCheckout').fill(process.cwd());
    releaseSuggestions();
    await expect(page.locator('#setupWork')).toBeHidden();
    await expect(page.locator('#checkout option')).toHaveCount(4);
    await expect(page.locator('#customCheckout')).toHaveValue(process.cwd(), 'a late suggestion must not replace a custom checkout');
    await expect(page.locator('#githubReadiness')).toContainText('GitHub connection is ready');
    await page.locator('#provider').selectOption('anthropic');
    await expect(page.locator('#keyEnv')).toHaveAttribute('placeholder', 'ANTHROPIC_API_KEY');
    await page.locator('#provider').selectOption('vertex');
    await expect(page.locator('#keyEnv')).toHaveAttribute('placeholder', 'GOOGLE_CLOUD_ACCESS_TOKEN');
    await page.locator('#reviewDetails > summary').click();
    await page.locator('#reviewMode').selectOption('custom');
    await page.locator('#reviewProvider').selectOption('openai');
    await expect(page.locator('#reviewKeyEnv')).toHaveAttribute('placeholder', 'OPENAI_API_KEY');
    await page.locator('#reviewProvider').selectOption('vertex');
    await expect(page.locator('#reviewKeyEnv')).toHaveAttribute('placeholder', 'GOOGLE_CLOUD_ACCESS_TOKEN');
    await page.locator('#reviewMode').selectOption('same');
    await page.locator('#provider').selectOption('openai-compatible');
    await expect(page.locator('#keyEnv')).toHaveAttribute('placeholder', 'OPENAI_API_KEY');
    await page.locator('#model').fill('local-test-model');
    await page.locator('#authMode').selectOption('none');
    await page.getByRole('button', { name: 'Save and start learning' }).click();
    await expect(page).toHaveURL(`${base}/`);
    await expect(page).toHaveTitle('Codebase Trail');
    await expect(page.locator('.topbar .brand')).toContainText('Understand the code. Keep up with the changes.');
    await page.locator('#scope').selectOption('lld');
    await expect(page.locator('#generate')).toBeEnabled({ timeout: 30_000 });
    let releaseSettingsPage;
    const settingsPageReady = new Promise((resolve) => { releaseSettingsPage = resolve; });
    await page.route(`${base}/settings`, async (route) => { await settingsPageReady; await route.continue(); });
    let releaseSettingsData;
    const settingsDataReady = new Promise((resolve) => { releaseSettingsData = resolve; });
    await page.route(`${base}/api/settings`, async (route) => { await settingsDataReady; await route.continue(); });
    const loadingVisible = await page.evaluate(() => {
      document.querySelector('.topbar a[href="/settings"]').click();
      return getComputedStyle(document.querySelector('#navigation-loading')).display !== 'none';
    });
    expect(loadingVisible).toBe(true);
    releaseSettingsPage();
    await expect(page).toHaveURL(`${base}/settings`);
    await expect(page.locator('#title')).toHaveText('Loading settings…');
    await expect(page.locator('#setupWork')).toBeVisible();
    await expect(page.locator('#workTitle')).toHaveText('Loading your settings');
    await expect(page.locator('#settings')).toBeHidden();
    releaseSettingsData();
    await page.unroute(`${base}/settings`);
    await page.unroute(`${base}/api/settings`);
    await expect(page.locator('#back')).toBeVisible();
    await expect(page.locator('#checkout')).toHaveValue(process.cwd());
    await page.getByText('Advanced model controls').click();
    await page.locator('#reasoningEffort').selectOption('none');
    await page.locator('#reviewReasoningEffort').selectOption('none');
    await page.locator('#reviewMaxOutputTokens').fill('512');
    await page.getByRole('button', { name: 'Save and start learning' }).click();
    await expect(page).toHaveURL(`${base}/`);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.locator('#reviewMode')).toHaveValue('same');
    await expect(page.locator('#reasoningEffort')).toHaveValue('none');
    await expect(page.locator('#reviewReasoningEffort')).toHaveValue('none');
    await expect(page.locator('#reviewMaxOutputTokens')).toHaveValue('512');
    await page.getByRole('link', { name: 'Back to learning' }).click();
    await expect(page.locator('#scope')).toHaveValue('pr');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
    delete process.env.CODE_LEARNING_HOME;
    delete process.env.CODE_LEARNING_STORE_PATH;
    delete process.env.CODE_LEARNING_CACHE_DIR;
  }
});

test('CLI provider setup hides API credentials and guides missing sign-in', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'code-learning-cli-setup-'));
  process.env.CODE_LEARNING_HOME = directory;
  const { createLauncher } = await import(`../launcher.mjs?cli-setup=${Date.now()}`);
  const server = createLauncher(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.route(`${base}/api/settings/sources`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checkouts: [process.cwd()], currentCheckout: process.cwd() }) }));
    await page.route(`${base}/api/settings/checks`, (route) => {
      const selected = route.request().postDataJSON().provider;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checks: [
        { name: 'Node.js', ok: true, required: true, detail: 'Ready' }, { name: 'git', ok: true, required: true, detail: 'Ready' }, { name: 'Source checkout', ok: true, required: true, detail: process.cwd() },
        { name: 'Claude CLI', ok: true, required: selected === 'claude-cli', detail: 'Installed' },
        { name: 'Codex CLI', ok: false, required: selected === 'codex-cli', detail: 'Install Codex CLI' },
        ...(selected === 'claude-cli' ? [{ name: 'Claude sign-in', ok: false, required: true, detail: 'Run claude auth login' }] : []),
      ] }) });
    });
    await page.goto(`${base}/settings`);
    await expect(page.locator('#provider option[value="claude-cli"]')).toBeEnabled();
    await expect(page.locator('#provider option[value="codex-cli"]')).toBeDisabled();
    await expect(page.locator('#reviewProvider option[value="codex-cli"]')).toBeDisabled();
    await expect(page.locator('#cliAvailability')).toContainText('Install Codex CLI');
    await expect(page.locator('#cliAvailability a')).toHaveAttribute('href', 'https://learn.chatgpt.com/docs/codex/cli');
    await page.locator('#provider').selectOption('claude-cli');
    await expect(page.locator('#apiConfig')).toBeHidden();
    await expect(page.locator('#cliHelp')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Model ID', exact: true })).toBeVisible();
    await expect(page.locator('#model')).toHaveValue('default');
    await expect(page.locator('#modelSuggestions option')).toHaveCount(4);
    await expect(page.getByRole('combobox', { name: 'Model preset', exact: true })).toBeVisible();
    await expect(page.locator('#modelChoice option')).toHaveCount(5);
    await expect(page.locator('#modelChoice')).toHaveValue('default');
    await page.locator('#modelChoice').selectOption('haiku');
    await expect(page.locator('#model')).toHaveValue('haiku');
    await page.locator('#model').fill('claude-sonnet-4-5');
    await expect(page.locator('#model')).toHaveValue('claude-sonnet-4-5');
    await expect(page.locator('#modelChoice')).toHaveValue('__custom__');
    await page.locator('#modelChoice').selectOption('__custom__');
    await expect(page.locator('#model')).toHaveValue('claude-sonnet-4-5');
    await page.locator('#model').fill('sonnet');
    await expect(page.locator('#modelChoice')).toHaveValue('sonnet');
    await expect(page.locator('#modelHelp')).toContainText('claude-haiku-4-5-20251001');
    await expect(page.locator('#timeoutMs')).toHaveAttribute('placeholder', '120');
    await expect(page.locator('#sourceEgress')).toHaveValue('remote');
    await expect(page.locator('#sourceEgress')).toBeDisabled();
    await expect(page.locator('#repairHelp')).toContainText('claude auth login');
    await expect(page.locator('#save')).toBeDisabled();
    await page.locator('#provider').selectOption('openai-compatible');
    await expect(page.locator('#modelChoice')).toBeHidden();
    await expect(page.locator('#apiConfig')).toBeVisible();
    await expect(page.locator('#sourceEgress')).toBeEnabled();
  } finally {
    server.close(); await once(server, 'close'); await rm(directory, { recursive: true, force: true }); delete process.env.CODE_LEARNING_HOME;
  }
});

test('later Settings saves preserve advanced limits and reviewer-only policy', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'code-learning-browser-settings-'));
  process.env.CODE_LEARNING_HOME = directory;
  const { createLauncher } = await import(`../launcher.mjs?browser=${Date.now()}`);
  const server = createLauncher();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.route(`${base}/api/settings`, async (route) => {
      if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });
    await page.route(`${base}/api/settings/checks`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checks: [
      { name: 'Node.js', ok: true, required: true, detail: 'Ready' }, { name: 'Source checkout', ok: true, required: true, detail: process.cwd() },
      { name: 'GitHub remote', ok: true, required: false, detail: 'fixture/repo' }, { name: 'gh', ok: true, required: false, detail: 'Ready' }, { name: 'GitHub authentication', ok: true, required: false, detail: 'Signed in' }, { name: 'GitHub repository access', ok: true, required: false, detail: 'fixture/repo' },
    ] }) }));
    await page.goto(`${base}/settings`);
    await expect(page.locator('#back')).toBeHidden();
    await expect(page.locator('#checkout')).toBeVisible();
    await expect(page.locator('#model')).toBeEmpty();
    await expect(page.locator('input[name="sourceMode"]')).toHaveCount(0);
    await page.route(`${base}/api/settings/models`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: ['vendor/model-a', 'vendor/model-b'] }) }));
    await page.locator('#endpoint').fill('https://openrouter.ai/api/v1');
    await page.locator('#loadModels').click();
    await expect(page.locator('#modelSuggestions option')).toHaveCount(2);
    await page.locator('#model').fill('vendor/model-b');
    await expect(page.locator('#model')).toBeVisible();
    await expect(page.locator('#model')).toHaveValue('vendor/model-b');
    const token = (await page.content()).match(/const token='([^']+)'/)[1];
    const config = { version: 1, source: { provider: 'local-git', checkout: process.cwd() }, model: {
      provider: 'openai-compatible', endpoint: 'http://127.0.0.1:11434/v1', model: 'local-model', authMode: 'none', apiKeyEnv: null,
      timeoutMs: 45_000, reviewProvider: 'openai-compatible', reviewEndpoint: 'http://127.0.0.1:11434/v1', reviewModel: 'local-model',
      reviewAuthMode: 'none', reviewApiKeyEnv: null, reviewSourceEgress: 'remote',
    } };
    const saved = await fetch(`${base}/api/settings`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-code-learning-token': token }, body: JSON.stringify({ config }) });
    expect(saved.status).toBe(200);
    await page.reload();
    await expect(page.locator('#back')).toBeVisible();
    await expect(page.locator('#reviewMode')).toHaveValue('custom');
    await expect(page.locator('#reviewSourceEgress')).toHaveValue('remote');
    await page.getByText('Advanced model controls').click();
    await page.getByText('Other options (expert JSON)').click();
    await expect(page.locator('#advancedModel')).toHaveValue(/"timeoutMs": 45000/);
    await page.locator('#advancedModel').fill('{"timeoutMs": 47000}');
    await expect(page.locator('#save')).toBeEnabled({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Save and start learning' }).click();
    await expect(page).toHaveURL(base + '/', { timeout: 20_000 });
    const response = await fetch(`${base}/api/settings`, { headers: { 'x-code-learning-token': token } });
    const state = await response.json();
    expect(state.savedConfig.model.timeoutMs).toBe(47_000);
    expect(state.savedConfig.model.reviewSourceEgress).toBe('remote');
    expect(state.savedConfig.model.reviewAuthMode).toBe('none');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
    delete process.env.CODE_LEARNING_HOME;
    delete process.env.CODE_LEARNING_STORE_PATH;
    delete process.env.CODE_LEARNING_CACHE_DIR;
  }
});

test('setup guides missing GitHub CLI and blocks an invalid checkout', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'code-learning-guidance-'));
  process.env.CODE_LEARNING_HOME = directory;
  const { createLauncher } = await import(`../launcher.mjs?guidance=${Date.now()}`);
  const server = createLauncher();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let ghReady = false;
  let authReady = false;
  try {
    await page.route(`${base}/api/settings/sources`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checkouts: [process.cwd()], currentCheckout: process.cwd() }) }));
    await page.route(`${base}/api/settings/checks`, async (route) => {
      const { checkout } = route.request().postDataJSON();
      const checks = [
        { name: 'Node.js', ok: true, required: true, detail: 'Ready' },
        { name: 'git', ok: true, required: true, detail: 'Ready' },
        { name: 'Source checkout', ok: checkout === process.cwd(), required: true, detail: checkout },
        { name: 'GitHub remote', ok: true, required: false, detail: 'fixture/repo' },
        { name: 'gh', ok: ghReady, required: false, detail: ghReady ? 'Ready' : 'Install gh' },
        ...(ghReady ? [{ name: 'GitHub authentication', ok: authReady, required: false, detail: authReady ? 'Signed in' : 'Sign in' }] : []),
        ...(authReady ? [{ name: 'GitHub repository access', ok: true, required: false, detail: 'fixture/repo' }] : []),
      ];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checks }) });
    });
    await page.route(`${base}/api/settings/github-login`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(route.request().method() === 'POST'
      ? { status: 'pending', code: 'ABCD-1234', url: 'https://github.com/login/device' }
      : { status: authReady ? 'connected' : 'pending' }) }));
    page.on('popup', (popup) => void popup.close());
    await page.goto(`${base}/settings`);
    await expect(page.locator('#githubReadiness')).toContainText('Install GitHub CLI');
    await expect(page.getByRole('link', { name: 'Install GitHub CLI' })).toBeVisible();
    await expect(page.locator('#githubReadiness')).toContainText('Copy help request for Codex or Claude');
    await expect(page.locator('#save')).toBeEnabled();
    ghReady = true;
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.locator('#githubReadiness')).toContainText('Sign in to GitHub');
    await page.getByRole('button', { name: 'Start GitHub sign-in' }).click();
    await expect(page.locator('#githubReadiness')).toContainText('ABCD-1234');
    await expect(page.getByRole('link', { name: 'Open the GitHub device page' })).toHaveAttribute('href', 'https://github.com/login/device');
    authReady = true;
    await expect(page.locator('#githubReadiness')).toContainText('GitHub connection is ready');
    await page.locator('#checkout').selectOption('__custom__');
    await page.locator('#customCheckout').fill('/missing/repository');
    await expect(page.locator('#checks')).toContainText('Source checkout: /missing/repository', { timeout: 10_000 });
    await expect(page.locator('#save')).toBeDisabled();
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
    delete process.env.CODE_LEARNING_HOME;
    delete process.env.CODE_LEARNING_STORE_PATH;
    delete process.env.CODE_LEARNING_CACHE_DIR;
  }
});

test('setup gives repair steps for missing npm, Git, and native parsers', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'code-learning-dependencies-'));
  process.env.CODE_LEARNING_HOME = directory;
  const { createLauncher } = await import(`../launcher.mjs?dependencies=${Date.now()}`);
  const server = createLauncher();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let repaired = false;
  const { dependencyChecks, settingsPaths, settingsSnapshot } = await import('../settings-store.mjs');
  const snapshot = await settingsSnapshot(settingsPaths());
  const parserFailure = (await dependencyChecks({}, { checkParsers: async () => { throw new Error('Synthetic parser failure'); }, runCommand: async () => ({ stdout: 'fixture version' }) })).find(({ name }) => name === 'Native parsers');
  try {
    // This rendering regression supplies checks below; initial setup must not run unrelated command probes.
    await page.route(`${base}/api/settings`, (route) => route.fulfill({ json: { setup: true, config: snapshot.public, savedConfig: {}, checks: [] } }));
    await page.route(`${base}/api/settings/sources`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checkouts: [process.cwd()], currentCheckout: process.cwd() }) }));
    await page.route(`${base}/api/settings/checks`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ platform: 'win32', architecture: 'arm64', checks: [
      { name: 'Node.js', ok: true, required: true, detail: 'Ready' },
      { name: 'npm', ok: repaired, required: false, detail: repaired ? 'Ready' : 'npm missing' },
      { ...parserFailure, ok: repaired, detail: repaired ? 'Ready' : parserFailure.detail },
      { name: 'git', ok: repaired, required: true, detail: repaired ? 'Ready' : 'Git missing' },
      { name: 'Source checkout', ok: repaired, required: true, detail: repaired ? process.cwd() : 'Git unavailable' },
      { name: 'gh', ok: false, required: false, detail: 'gh missing' },
    ] }) }));
    await page.goto(`${base}/settings`);
    await expect(page.locator('#repairHelp')).toBeVisible();
    await expect(page.locator('#repairHelp')).toContainText('Install x64 Node.js');
    await expect(page.locator('#repairHelp')).toContainText('npm ci --include=optional');
    await expect(page.locator('#repairHelp')).toContainText('Codebase Trail source checkout');
    await expect(page.locator('#repairHelp')).toContainText('docs/install.md');
    await expect(page.locator('#repairHelp')).not.toContainText('npm install -g codebase-trail');
    await expect(page.locator('#checks')).toContainText('npm ci --include=optional');
    await expect(page.locator('#checks')).toContainText('Codebase Trail source checkout');
    await expect(page.locator('#checks')).toContainText('docs/install.md');
    await expect(page.locator('#checks')).not.toContainText('npm install -g codebase-trail');
    await expect(page.locator('#repairHelp a[href="https://www.npmjs.com/package/codebase-trail"]')).toHaveCount(0);
    await expect(page.locator('#repairHelp')).toContainText('git --version');
    await expect(page.locator('#repairHelp')).toContainText('npm --version');
    await expect(page.locator('#repairHelp')).toContainText('Copy help request for Codex or Claude');
    await expect(page.locator('#save')).toBeDisabled();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.copiedHelpRequest = value; } } }));
    await page.locator('#repairHelp').getByRole('button', { name: 'Copy help request for Codex or Claude' }).click();
    expect(await page.evaluate(() => window.copiedHelpRequest)).toContain('Native parsers');
    expect(await page.evaluate(() => window.copiedHelpRequest)).not.toContain(process.cwd());
    repaired = true;
    await page.locator('#repairHelp').getByRole('button', { name: 'Check again' }).click();
    await expect(page.locator('#repairHelp')).toBeHidden();
    await expect(page.locator('#save')).toBeEnabled();
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
    delete process.env.CODE_LEARNING_HOME;
  }
});

for (const provider of ['claude-cli', 'openai-compatible']) {
  test(`${provider} saves typed model IDs and preserves edits when suggestions load`, async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'code-learning-model-input-'));
    process.env.CODE_LEARNING_HOME = directory;
    const previousPath = process.env.PATH;
    const fakeBin = join(directory, 'bin');
    await mkdir(fakeBin);
    // Activation checks the selected CLI independently of the browser's fake checks.
    // Never use the developer's real CLI login for this regression.
    await writeFile(join(fakeBin, 'claude'), '#!/bin/sh\ncase "$1" in --version) echo "fixture-cli";; auth) exit 0;; *) exit 1;; esac\n', { mode: 0o755 });
    await writeFile(join(fakeBin, 'claude.cmd'), '@echo off\r\nif "%1"=="--version" (echo fixture-cli & exit /b 0)\r\nif "%1"=="auth" exit /b 0\r\nexit /b 1\r\n');
    process.env.PATH = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${previousPath}`;
    const { createLauncher } = await import(`../launcher.mjs?model-input=${provider}-${Date.now()}`);
    const server = createLauncher(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await page.setViewportSize({ width: 900, height: 650 });
      const { settingsPaths, settingsSnapshot } = await import('../settings-store.mjs');
      // Read actual persisted settings on every reload without unrelated command probes.
      await page.route(`${base}/api/settings`, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const snapshot = await settingsSnapshot(settingsPaths());
        return route.fulfill({ json: { setup: !snapshot.exists, config: snapshot.public, savedConfig: snapshot.rawConfig, checks: [] } });
      });
      await page.route(`${base}/api/settings/sources`, (route) => route.fulfill({ json: { checkouts: [process.cwd()], currentCheckout: process.cwd() } }));
      await page.route(`${base}/api/settings/checks`, (route) => route.fulfill({ json: { checks: [
        { name: 'Source checkout', ok: true, required: true, detail: process.cwd() },
        { name: 'Claude CLI', ok: true, required: false, detail: 'Installed' },
        { name: 'Claude sign-in', ok: true, required: false, detail: 'Signed in' },
      ] } }));
      await page.route(`${base}/api/candidates`, (route) => route.fulfill({ json: { candidates: [] } }));
      await page.route(`${base}/api/architecture/catalog`, (route) => route.fulfill({ json: { scopes: {}, services: [] } }));
      await page.route(`${base}/api/architecture/practice/prefetch`, (route) => route.fulfill({ status: 204 }));
      await page.goto(`${base}/settings`);
      await expect(page.locator('#save')).toBeEnabled();
      await page.locator('#provider').selectOption(provider);
      const model = page.getByRole('combobox', { name: 'Model ID', exact: true });
      const id = provider === 'claude-cli' ? 'claude-haiku-4-5-20251001' : 'vendor/custom-model';
      await model.fill(id);
      await expect(model).toHaveValue(id);
      await expect(page.locator('#modelSaveHelp')).toContainText('Save and start learning');
      if (provider === 'openai-compatible') {
        await page.locator('#authMode').selectOption('none');
        let deliver;
        const pending = new Promise((resolve) => { deliver = resolve; });
        await page.route(`${base}/api/settings/models`, async (route) => { await pending; await route.fulfill({ json: { models: ['vendor/model-a', 'vendor/model-b'] } }); });
        await page.locator('#loadModels').click();
        await model.fill('vendor/edited-model');
        deliver();
        await expect(page.locator('#modelSuggestions option')).toHaveCount(2);
        await expect(model).toHaveValue('vendor/edited-model');
      }
      const expected = await model.inputValue();
      await model.scrollIntoViewIfNeeded();
      await expect(page.locator('#save')).toBeInViewport();
      await expect(page.locator('#save')).toBeEnabled();
      await page.locator('#save').click();
      await expect(page).toHaveURL(`${base}/`);
      await page.goto(`${base}/settings`);
      await expect(model).toHaveValue(expected);
      await expect(page.locator('#provider')).toHaveValue(provider);
      if (provider === 'claude-cli') {
        await expect(page.locator('#modelChoice')).toHaveValue('__custom__');
        await page.locator('#modelChoice').selectOption('haiku');
        await expect(model).toHaveValue('haiku');
        await expect(page.locator('#save')).toBeEnabled();
        await page.locator('#save').click();
        await expect(page).toHaveURL(`${base}/`);
        await page.goto(`${base}/settings`);
        await expect(model).toHaveValue('haiku');
        await expect(page.locator('#modelChoice')).toHaveValue('haiku');
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await model.scrollIntoViewIfNeeded();
      await expect(page.locator('#save')).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `/tmp/codebase-trail-model-input-${provider}.png` });
    } finally {
      server.close(); await once(server, 'close'); await rm(directory, { recursive: true, force: true });
      process.env.PATH = previousPath;
      delete process.env.CODE_LEARNING_HOME; delete process.env.CODE_LEARNING_STORE_PATH; delete process.env.CODE_LEARNING_CACHE_DIR;
    }
  });
}

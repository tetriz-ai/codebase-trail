#!/usr/bin/env node
// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commitSettings, dependencyChecks, detectSources, discoverModels, prepareSettings, settingsPaths, settingsSnapshot } from './settings-store.mjs';
import { loadConfig, publicConfig } from './config.mjs';
import { getLaunchRuntime, setLaunchRuntime } from './launcher-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const token = randomBytes(32).toString('base64url');
const cliArguments = launchedAsCommand() ? process.argv.slice(2) : null;
const helpRequested = cliArguments && (cliArguments.length === 1 && cliArguments[0] === '--help' || cliArguments.length === 2 && ['start', 'init'].includes(cliArguments[0]) && cliArguments[1] === '--help');
const validCommand = cliArguments === null || cliArguments.length === 0 || cliArguments.length === 1 && ['start', 'init'].includes(cliArguments[0]);
const paths = helpRequested || !validCommand ? null : settingsPaths();
let activeApp = null;
let setupError = null;

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
function equalToken(value) {
  if (typeof value !== 'string') return false;
  const left = Buffer.from(value); const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}
function securityError(request) {
  const host = String(request.headers.host || '').toLowerCase();
  if (!/^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(host)) return [403, 'Local request host rejected.'];
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) return [403, 'Cross-origin request rejected.'];
  const site = String(request.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && !['same-origin', 'none'].includes(site)) return [403, 'Cross-site request rejected.'];
  if (request.url?.startsWith('/api/settings')) {
    if (!equalToken(request.headers['x-code-learning-token'])) return [403, 'API capability token rejected.'];
    if (request.method === 'POST' && (!origin || String(request.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/json')) return [403, 'Settings changes require the local UI.'];
  }
  return null;
}
async function activate(snapshot) {
  const checks = await dependencyChecks({ source: snapshot.config.source, model: snapshot.config.model }, { verifyRepository: true });
  const failure = checks.find((check) => check.required !== false && !check.ok);
  if (failure) { const error = new Error(`${failure.name}: ${failure.detail}`); error.statusCode = 422; throw error; }
  process.env.CODE_LEARNING_STORE_PATH ||= paths.history;
  process.env.CODE_LEARNING_CACHE_DIR ||= paths.cache;
  const previous = getLaunchRuntime();
  setLaunchRuntime({ config: snapshot.config, env: snapshot.env });
  try { return (await import(`./server.mjs?settings=${randomBytes(8).toString('hex')}`)).app; }
  finally { setLaunchRuntime(previous); }
}
async function readBody(request) {
  let body = '';
  for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 64 * 1024) throw new Error('Settings request exceeds 64 KiB.'); }
  return JSON.parse(body);
}

export function createLauncher() {
  let pendingSave = Promise.resolve();
  let githubLogin = null;
  return createServer(async (request, response) => {
    const error = securityError(request);
    if (error) return json(response, error[0], { error: error[1] });
    try {
      if (request.url === '/settings' && request.method === 'GET') {
        const nonce = randomBytes(24).toString('base64url');
        const html = (await readFile(join(here, 'settings.html'), 'utf8')).replaceAll('__CODE_LEARNING_API_TOKEN__', token).replaceAll('__CODE_LEARNING_CSP_NONCE__', nonce);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
        return response.end(html);
      }
      if (request.url === '/api/settings' && request.method === 'GET') {
        let snapshot;
        try { snapshot = await settingsSnapshot(paths); }
        catch (loadError) {
          const config = await loadConfig({ env: {} });
          snapshot = { exists: false, config, public: publicConfig(config, { env: {} }) };
          setupError = loadError.message;
        }
        return json(response, 200, { setup: !snapshot.exists, config: snapshot.public, savedConfig: snapshot.rawConfig || {}, checks: await dependencyChecks({ source: snapshot.config.source, model: snapshot.config.model }), platform: process.platform, architecture: process.arch, error: setupError });
      }
      if (request.url === '/api/settings/sources' && request.method === 'GET') {
        const snapshot = await settingsSnapshot(paths);
        return json(response, 200, await detectSources({ savedSource: snapshot.rawConfig?.source }));
      }
      if (request.url === '/api/settings/checks' && request.method === 'POST') {
        const input = await readBody(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['checkout', 'provider', 'reviewProvider'].includes(key)) || typeof input.checkout !== 'string' || input.checkout.length > 4096 || ![undefined, 'claude-cli', 'codex-cli', 'openai-compatible', 'openai', 'anthropic', 'vertex'].includes(input.provider) || ![undefined, 'claude-cli', 'codex-cli', 'openai-compatible', 'openai', 'anthropic', 'vertex'].includes(input.reviewProvider)) return json(response, 400, { error: 'Choose a valid checkout and model provider to check.' });
        return json(response, 200, { checks: await dependencyChecks({ source: { provider: 'local-git', checkout: input.checkout }, model: { provider: input.provider, reviewProvider: input.reviewProvider } }, { verifyRepository: true }), platform: process.platform, architecture: process.arch });
      }
      if (request.url === '/api/settings/github-login' && request.method === 'POST') {
        if (githubLogin?.state.status === 'pending') return json(response, 409, { error: 'GitHub sign-in is already in progress.' });
        githubLogin = signInToGitHub();
        try { return json(response, 200, await githubLogin.ready); }
        catch { return json(response, 422, { error: githubLogin.state.error || 'Could not start GitHub sign-in. Run gh auth login --web in your terminal, then check again.' }); }
      }
      if (request.url === '/api/settings/github-login' && request.method === 'GET') {
        return json(response, 200, { status: githubLogin?.state.status || 'idle', error: githubLogin?.state.error || null });
      }
      if (request.url === '/api/settings/models' && request.method === 'POST') {
        const input = await readBody(request);
        if (!input || typeof input !== 'object' || Object.keys(input).some((key) => !['provider', 'endpoint', 'authMode', 'apiKeyEnv', 'credential'].includes(key))) return json(response, 400, { error: 'Invalid model lookup request.' });
        const snapshot = await settingsSnapshot(paths);
        const credential = input.credential || snapshot.env[input.apiKeyEnv] || '';
        try { return json(response, 200, await discoverModels({ ...input, credential })); }
        catch (lookupError) { return json(response, 422, { error: lookupError.message }); }
      }
      if (request.url === '/api/settings' && request.method === 'POST') {
        const input = await readBody(request);
        const save = pendingSave.then(async () => {
          const prepared = await prepareSettings(paths, input);
          const candidateApp = await activate(prepared);
          await commitSettings(paths, prepared);
          activeApp = candidateApp;
          setupError = null;
          return { status: 'ready', config: publicConfig(prepared.config, { env: prepared.env }) };
        });
        pendingSave = save.catch(() => {});
        return json(response, 200, await save);
      }
      if (!activeApp) {
        if (request.method === 'GET' && (request.url === '/' || request.url === '/index.html')) { response.writeHead(302, { location: '/settings', 'cache-control': 'no-store' }); return response.end(); }
        return json(response, 503, { error: setupError || 'Complete setup in Settings before using Codebase Trail.' });
      }
      return activeApp(request, response);
    } catch (requestError) {
      const status = request.url === '/api/settings' && request.method === 'POST' ? requestError.statusCode || 400 : 500;
      if (status === 422) setupError = requestError.message;
      return json(response, status, { error: status === 400 || status === 422 ? requestError.message : 'Settings could not be loaded.' });
    }
  });
}

function launchedAsCommand() {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

function openBrowser(url) {
  if (process.env.CODEBASE_TRAIL_NO_BROWSER === '1' || process.env.CODE_LEARNING_NO_BROWSER === '1' || process.env.CI) return;
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `start "" "${url}"`] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

export function signInToGitHub(spawnCommand = spawn, { promptTimeoutMs = 30_000, loginTimeoutMs = 180_000 } = {}) {
  const state = { status: 'pending', error: null };
  let resolveReady; let rejectReady; let resolveCompletion;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const child = spawnCommand('gh', ['auth', 'login', '--web', '--clipboard', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, GH_HOST: 'github.com' } });
  let output = ''; let promptSent = false; let finished = false;
  const finish = (error) => {
    if (finished) return;
    finished = true; clearTimeout(promptTimeout); clearTimeout(loginTimeout);
    state.status = error ? 'failed' : 'connected';
    state.error = error ? error.message : null;
    if (!promptSent) {
      if (error) rejectReady(error);
      else resolveReady({ status: 'connected' });
    }
    resolveCompletion(state);
  };
  child.stderr?.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-8_192);
    const code = output.match(/(?:One-time code \(|First copy your one-time code:\s*)([A-Z0-9-]{8,16})/i)?.[1];
    const url = output.match(/https:\/\/github\.com\/login\/device\b/i)?.[0];
    if (code && url && !promptSent) { promptSent = true; clearTimeout(promptTimeout); resolveReady({ status: 'pending', code, url }); }
  });
  child.once('error', (error) => finish(error));
  child.once('exit', (code) => finish(code === 0 ? null : new Error('GitHub sign-in did not complete. Run gh auth login --web in your terminal, then check again.')));
  const promptTimeout = setTimeout(() => { child.kill(); finish(new Error('GitHub did not provide a sign-in code. Run gh auth login --web in your terminal.')); }, promptTimeoutMs);
  const loginTimeout = setTimeout(() => { child.kill(); finish(new Error('GitHub sign-in timed out. Try again or run gh auth login --web in your terminal.')); }, loginTimeoutMs);
  return { ready, completion, state };
}

export function initialPage(command, ready) {
  if (!['start', 'init'].includes(command)) throw new Error('Usage: codebase-trail [init]');
  return command === 'init' || !ready ? '/settings' : '/';
}

if (launchedAsCommand()) {
  const command = process.argv[2] || 'start';
  if (helpRequested) console.log('Usage: codebase-trail [start|init]\n\nstart  Open practice, or setup when no settings are saved.\ninit   Open setup.\n\nRequires Node.js 20+ and Git. Configure the source and model in Settings.\nSet CODEBASE_TRAIL_NO_BROWSER=1 to print the URL without opening a browser.');
  else if (!validCommand) { console.error('Usage: codebase-trail [init]'); process.exitCode = 2; }
  else {
    try {
      const snapshot = await settingsSnapshot(paths);
      if (snapshot.exists) activeApp = await activate(snapshot);
    } catch (error) { setupError = error.message; }
    const port = Number(process.env.PORT || 4178);
    const server = createLauncher();
    server.listen(port, '127.0.0.1', () => {
      const url = new URL(initialPage(command, Boolean(activeApp)), `http://127.0.0.1:${server.address().port}`).href;
      console.log(`Codebase Trail: ${url}${setupError ? ` (${setupError})` : ''}`);
      openBrowser(url);
    });
  }
}

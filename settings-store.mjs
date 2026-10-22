// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, mkdir, rename, writeFile, readdir, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import crossSpawn from 'cross-spawn';
import { loadConfig, publicConfig } from './config.mjs';

const execFile = promisify(execFileCallback);

function runCliCommand(command, args, { timeout = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${command} check timed out`)); }, timeout);
    child.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 64_000) { child.kill(); finish(new Error(`${command} output exceeded the limit`)); } });
    child.stderr.resume();
    child.on('close', (code) => finish(code === 0 ? null : new Error(`${command} exited with status ${code}`), { stdout }));
  });
}

export function settingsPaths(env = process.env, { platformName = platform(), homeDirectory = homedir() } = {}) {
  const profile = platformName === 'win32' ? env.APPDATA || join(homeDirectory, 'AppData', 'Roaming')
    : platformName === 'darwin' ? join(homeDirectory, 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME || join(homeDirectory, '.config');
  const modern = join(profile, platformName === 'win32' || platformName === 'darwin' ? 'Codebase Trail' : 'codebase-trail');
  const legacy = platformName === 'win32' || platformName === 'darwin'
    ? join(profile, 'Tetriz', 'Code Learning') : join(profile, 'tetriz', 'code-learning');
  const hasSettings = (directory) => existsSync(join(directory, 'settings.json')) || existsSync(join(directory, 'config.json'));
  const base = env.CODEBASE_TRAIL_HOME || env.CODE_LEARNING_HOME || (hasSettings(modern) || !hasSettings(legacy) ? modern : legacy);
  const directory = resolve(base);
  return { directory, state: join(directory, 'settings.json'), config: resolve(env.CODEBASE_TRAIL_CONFIG || env.CODE_LEARNING_CONFIG || join(directory, 'config.json')), credentials: join(directory, 'credentials.json'), history: join(directory, 'history.json'), cache: join(directory, 'cache') };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicJson(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await rename(temp, file); }
  catch (error) { try { await import('node:fs/promises').then(({ unlink }) => unlink(temp)); } catch { /* Optional discovery or cleanup failure does not block this operation. */ } throw error; }
}

export async function settingsSnapshot(paths, env = process.env) {
  let state = await readJson(paths.state, null);
  let exists = state !== null;
  if (!exists) {
    const legacyConfig = await readJson(paths.config, null);
    exists = legacyConfig !== null;
    state = { config: legacyConfig || {}, credentials: await readJson(paths.credentials, {}) };
  }
  if (!state || typeof state !== 'object' || Array.isArray(state) || !state.config || typeof state.config !== 'object' || Array.isArray(state.config) || !state.credentials || typeof state.credentials !== 'object' || Array.isArray(state.credentials)) throw new Error('Saved settings are invalid.');
  const config = await loadConfig({ overrides: state.config, env: {} });
  const effectiveEnv = { ...state.credentials, ...env };
  return { exists, config, rawConfig: state.config, public: publicConfig(config, { env: effectiveEnv }), credentials: state.credentials, env: effectiveEnv };
}

export async function prepareSettings(paths, payload, env = process.env) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => !['config', 'credentials'].includes(key))) throw new Error('Invalid settings request.');
  const candidate = payload.config;
  const secrets = payload.credentials || {};
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !secrets || typeof secrets !== 'object' || Array.isArray(secrets)) throw new Error('Invalid settings request.');
  let previous;
  try { previous = await settingsSnapshot(paths, env); }
  catch { previous = { credentials: {} }; }
  const credentials = { ...previous.credentials };
  for (const [name, value] of Object.entries(secrets)) {
    if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(name) || value !== null && (typeof value !== 'string' || value.length > 16_384)) throw new Error('Invalid credential setting.');
    if (value === null) delete credentials[name];
    else if (value) credentials[name] = value;
  }
  // CLI settings own configuration; environment variables supply credentials only.
  const config = await loadConfig({ overrides: candidate, env: {} });
  for (const name of Object.keys(secrets)) if (![config.model.apiKeyEnv, config.model.reviewApiKeyEnv].includes(name)) throw new Error('Credential variable does not match the selected model.');
  for (const name of Object.keys(credentials)) if (![config.model.apiKeyEnv, config.model.reviewApiKeyEnv].includes(name)) delete credentials[name];
  const publicSettings = publicConfig(config, { env: { ...credentials, ...env } });
  for (const policy of [publicSettings.model.credential, publicSettings.model.reviewCredential]) {
    if (policy.required && !policy.configured) throw new Error(`${policy.envVar} is required for the selected provider.`);
  }
  return { config, rawConfig: candidate, credentials, env: { ...credentials, ...env } };
}

export async function commitSettings(paths, prepared) {
  await atomicJson(paths.state, { config: prepared.rawConfig, credentials: prepared.credentials });
}

export async function saveSettings(paths, payload, env = process.env) {
  const prepared = await prepareSettings(paths, payload, env);
  await commitSettings(paths, prepared);
  return prepared;
}

export async function detectSources({ directory = process.cwd(), homeDirectory = homedir(), savedSource = {}, runCommand = execFile } = {}) {
  const checkouts = new Set();
  const repositories = new Set();
  if (savedSource.checkout) checkouts.add(savedSource.checkout);
  if (savedSource.repository) repositories.add(savedSource.repository);
  // Look only one level below likely checkout locations. A user's home can
  // contain very large mounts, so avoid a recursive filesystem walk.
  const roots = new Set([dirname(resolve(directory)), homeDirectory]);
  for (const name of ['code', 'dev', 'git', 'projects', 'repos', 'workspace', 'worktrees', 'Desktop', 'Documents']) roots.add(join(homeDirectory, name));
  const inspect = async (base) => {
    try {
      const marker = await stat(join(base, '.git'));
      if (marker.isDirectory() || marker.isFile()) checkouts.add(base);
    } catch { /* Optional discovery or cleanup failure does not block this operation. */ }
  };
  await Promise.all([...roots].map(async (root) => {
    await inspect(root);
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules').slice(0, 250).map((entry) => inspect(join(root, entry.name))));
  }));
  let checkout;
  try {
    checkout = (await runCommand('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { timeout: 5_000, windowsHide: true })).stdout.trim();
    if (checkout) checkouts.add(checkout);
  } catch { /* Optional discovery or cleanup failure does not block this operation. */ }
  if (checkout) {
    try {
      const output = (await runCommand('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: checkout, timeout: 8_000, windowsHide: true })).stdout;
      const name = JSON.parse(output).nameWithOwner;
      if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)) repositories.add(name);
    } catch { /* Optional discovery or cleanup failure does not block this operation. */ }
  }
  try {
    const output = (await runCommand('gh', ['repo', 'list', '--limit', '30', '--json', 'nameWithOwner'], { timeout: 8_000, windowsHide: true })).stdout;
    for (const item of JSON.parse(output)) if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item?.nameWithOwner)) repositories.add(item.nameWithOwner);
  } catch { /* Optional discovery or cleanup failure does not block this operation. */ }
  return { checkouts: [...checkouts].sort(), repositories: [...repositories].sort(), currentCheckout: checkout || null };
}

export async function discoverModels({ provider, endpoint, authMode, credential, fetcher = globalThis.fetch }) {
  if (provider === 'claude-cli' || provider === 'codex-cli') throw new Error('The CLI uses its selected model or its configured default. Enter a model ID manually.');
  if (!['openai-compatible', 'openai', 'anthropic'].includes(provider)) throw new Error('Enter the Vertex model ID manually.');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Enter a valid API base URL before loading models.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Model API URL must use HTTPS, except for localhost, and cannot contain credentials.');
  if (!['auto', 'bearer', 'x-api-key', 'none'].includes(authMode) || typeof credential !== 'string' || credential.length > 16_384) throw new Error('Invalid model authentication settings.');
  const headers = { accept: 'application/json' };
  if (credential && authMode !== 'none') headers[provider === 'anthropic' || authMode === 'x-api-key' ? 'x-api-key' : 'authorization'] = provider === 'anthropic' || authMode === 'x-api-key' ? credential : `Bearer ${credential}`;
  if (provider === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  let response;
  try { response = await fetcher(`${url.href.replace(/\/$/, '')}/models`, { headers, signal: AbortSignal.timeout(8_000), redirect: 'error' }); }
  catch { throw new Error('Could not reach the model endpoint. Check the URL and connection.'); }
  if (response.status === 401 || response.status === 403) throw new Error('The model endpoint rejected the credential.');
  if (!response.ok) throw new Error(response.status === 404 ? 'This endpoint has no model list.' : `Model list request failed (HTTP ${response.status}).`);
  if (Number(response.headers.get('content-length')) > 8_000_000) throw new Error('The model list was too large.');
  let body = '';
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8_000_000) { await reader.cancel(); throw new Error('The model list was too large.'); }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally { reader.releaseLock(); }
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error('The model endpoint returned invalid JSON.'); }
  const models = Array.isArray(parsed?.data) ? parsed.data : [];
  return { models: [...new Set(models.map((item) => item?.id).filter((id) => typeof id === 'string' && id.length <= 200))].sort().slice(0, 3_000) };
}

export function githubRepositoryFromRemote(remote) {
  const match = String(remote || '').trim().match(/^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

export async function dependencyChecks({ source, model } = {}, { verifyRepository = false, runCommand = execFile, checkParsers = async () => {
  const { parseSource } = await import('./syntax-analysis.mjs');
  for (const [file, content] of [['check.go', 'package main'], ['check.py', 'print(1)'], ['Check.java', 'class Check {}'], ['Check.kt', 'class Check'], ['check.rs', 'fn main() {}'], ['check.rb', 'puts 1'], ['Check.cs', 'class Check {}']]) parseSource(file, content);
} } = {}) {
  const checks = [{ name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 20, required: true, detail: `v${process.versions.node}; requires 20 or newer` }];
  try {
    await checkParsers();
    checks.push({ name: 'Native parsers', ok: true, required: true, detail: 'All supported language parsers loaded' });
  } catch {
    const guidance = `${process.platform === 'win32' && process.arch === 'arm64' ? 'Install x64 Node.js on Windows ARM64. ' : ''}Close Codebase Trail. For a source install, run npm ci --include=optional in the Codebase Trail source checkout. For a release install, follow the native-parser repair instructions in docs/install.md.`;
    checks.push({ name: 'Native parsers', ok: false, required: true, detail: guidance });
  }
  for (const [name, required] of [['npm', false], ['git', true], ['gh', source?.provider === 'github-gh']]) {
    try {
      const command = name === 'npm' && process.platform === 'win32' ? 'cmd.exe' : name;
      const args = command === 'cmd.exe' ? ['/d', '/s', '/c', 'npm --version'] : ['--version'];
      const { stdout } = await runCommand(command, args, { timeout: 5_000, windowsHide: true });
      checks.push({ name, ok: true, required, detail: stdout.trim().split('\n')[0] });
    } catch { checks.push({ name, ok: false, required, detail: name === 'npm' ? 'npm is needed to install or repair Codebase Trail. Install Node.js with npm and add it to PATH.' : `Install ${name} and add it to PATH${name === 'gh' ? ' for PR learning' : ''}.` }); }
  }
  let repository = source?.provider === 'github-gh' ? source.repository : null;
  if (source?.provider === 'local-git' && source.checkout) {
    try {
      await runCommand('git', ['-C', source.checkout, 'rev-parse', '--is-inside-work-tree'], { timeout: 5_000, windowsHide: true });
      checks.push({ name: 'Source checkout', ok: true, required: true, detail: source.checkout });
      try {
        const { stdout } = await runCommand('git', ['-C', source.checkout, 'remote', 'get-url', 'origin'], { timeout: 5_000, windowsHide: true });
        repository = githubRepositoryFromRemote(stdout);
      } catch { /* Optional discovery or cleanup failure does not block this operation. */ }
      checks.push({ name: 'GitHub remote', ok: Boolean(repository), required: false, detail: repository || 'Add a GitHub origin remote to this checkout to enable PR questions.' });
    } catch { checks.push({ name: 'Source checkout', ok: false, required: true, detail: 'Choose a local Git checkout in Settings.' }); }
  }
  if (checks.find((item) => item.name === 'gh')?.ok) {
    const hostname = source?.hostname || 'github.com';
    try {
      await runCommand('gh', ['auth', 'status', '--active', '--hostname', hostname], { timeout: 8_000, windowsHide: true });
      checks.push({ name: 'GitHub authentication', ok: true, required: source?.provider === 'github-gh', detail: `Signed in to ${hostname}` });
      if (verifyRepository && repository) {
        try {
          await runCommand('gh', ['repo', 'view', repository, '--json', 'nameWithOwner'], { timeout: 10_000, windowsHide: true, env: { ...process.env, GH_HOST: hostname } });
          checks.push({ name: 'GitHub repository access', ok: true, required: source?.provider === 'github-gh', detail: repository });
        } catch { checks.push({ name: 'GitHub repository access', ok: false, required: source?.provider === 'github-gh', detail: `GitHub cannot access ${repository}. Check your account and repository permissions.` }); }
      }
    } catch { checks.push({ name: 'GitHub authentication', ok: false, required: source?.provider === 'github-gh', detail: `Run gh auth login --hostname ${hostname} for PR learning.` }); }
  }
  for (const provider of ['claude-cli', 'codex-cli']) {
    const command = provider === 'claude-cli' ? 'claude' : 'codex';
    const label = provider === 'claude-cli' ? 'Claude' : 'Codex';
    const selected = model?.provider === provider || model?.reviewProvider === provider;
    const cliCommand = runCommand === execFile ? runCliCommand : runCommand;
    try {
      const { stdout } = await cliCommand(command, ['--version'], { timeout: 5_000, windowsHide: true });
      checks.push({ name: `${label} CLI`, ok: true, required: selected, detail: stdout.trim().split('\n')[0] });
    } catch {
      checks.push({ name: `${label} CLI`, ok: false, required: selected, detail: `Install ${label} CLI and add ${command} to PATH, then select Check again.` });
      continue;
    }
    if (!selected) continue;
    try {
      await cliCommand(command, provider === 'claude-cli' ? ['auth', 'status'] : ['login', 'status'], { timeout: 8_000, windowsHide: true });
      checks.push({ name: `${label} sign-in`, ok: true, required: true, detail: `${label} CLI is signed in` });
    } catch { checks.push({ name: `${label} sign-in`, ok: false, required: true, detail: `Run ${command} ${provider === 'claude-cli' ? 'auth login' : 'login'} in your terminal, then select Check again.` }); }
  }
  return checks;
}

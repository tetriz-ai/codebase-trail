// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import './test-safety.mjs';
import assert from 'node:assert/strict';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this smoke test through npm run test:install.');

const temporary = await mkdtemp(join(tmpdir(), 'code-learning-install-'));
const npmEnv = { ...process.env, npm_config_cache: process.env.npm_config_cache || join(temporary, 'npm-cache') };
let launcher;
try {
  const packed = await execFile(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', temporary], { cwd: packageDir, timeout: 120_000, env: npmEnv });
  const packResult = JSON.parse(packed.stdout);
  const packInfo = Array.isArray(packResult) ? packResult[0] : Object.values(packResult).find((entry) => entry?.filename);
  assert.ok(packInfo?.filename, `npm pack did not report a tarball: ${packed.stdout.slice(0, 500)}`);
  const sourcePackage = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(sourcePackage.private, true, 'GitHub distribution must prevent registry publishing');
  assert.equal(packInfo.filename, `codebase-trail-${sourcePackage.version}.tgz`);
  const tarball = join(temporary, packInfo.filename);
  const prefix = join(temporary, 'installed');
  await execFile(process.execPath, [npmCli, 'install', '--prefix', prefix, '--no-audit', '--no-fund', tarball], { timeout: 180_000, env: npmEnv });

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  reservation.close();
  await once(reservation, 'close');

  const installedLauncher = join(prefix, 'node_modules', 'codebase-trail', 'launcher.mjs');
  const installedPackage = JSON.parse(await readFile(join(prefix, 'node_modules', 'codebase-trail', 'package.json'), 'utf8'));
  assert.match(await readFile(join(prefix, 'node_modules', 'codebase-trail', 'NOTICE'), 'utf8'), /Lucide Contributors 2022/);
  assert.match(await readFile(join(prefix, 'node_modules', 'codebase-trail', 'third_party', 'licenses', 'lucide.txt'), 'utf8'), /copyright notice and this permission notice appear in all copies/);
  const installedRoot = dirname(installedLauncher);
  const readme = await readFile(join(installedRoot, 'README.md'), 'utf8');
  const references = [...readme.matchAll(/\]\(([^)]+)\)|(?:src|srcset)="([^"]+)"/g)].map((match) => match[1] || match[2]);
  for (const reference of references) {
    if (/^(?:https?:|#)/.test(reference)) continue;
    const target = resolve(installedRoot, reference.split('#')[0]);
    assert.ok(target.startsWith(`${installedRoot}${sep}`), `README reference escapes the installed package: ${reference}`);
    await stat(target);
  }
  await stat(join(installedRoot, 'scripts', 'example-session.mjs'));
  await stat(join(installedRoot, 'scripts', 'test-safety.mjs'));
  for (const example of ['practice-a-boundary', 'register-extractor', 'revisit-an-answer']) {
    const exampleReadme = await readFile(join(installedRoot, 'examples', example, 'README.md'), 'utf8');
    const command = exampleReadme.match(/```sh\n([^\n]+)\n```/)?.[1];
    const expected = exampleReadme.match(/```text\n([\s\S]*?)\n```/)?.[1];
    assert.match(command || '', /^node examples\/[a-z-]+\/main\.mjs$/);
    assert.notEqual(expected, undefined);
    const { stdout } = await execFile(process.execPath, command.split(' ').slice(1), { cwd: installedRoot, env: npmEnv, timeout: 60_000 });
    assert.equal(stdout, `${expected}\n`, `Installed ${example} output must match its README.`);
  }
  assert.equal(installedPackage.name, 'codebase-trail');
  assert.equal(installedPackage.private, true);
  assert.equal(installedPackage.license, 'MIT');
  assert.match(await readFile(join(prefix, 'node_modules', 'codebase-trail', 'LICENSE'), 'utf8'), /MIT License/);
  assert.equal(installedPackage.bin?.['codebase-trail'], './launcher.mjs');
  await stat(join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'codebase-trail.cmd' : 'codebase-trail'));
  for (const args of [['--help'], ['start', '--help'], ['init', '--help']]) {
    const { stdout, stderr } = await execFile(process.execPath, [npmCli, 'exec', '--offline', '--yes', `--package=${tarball}`, '--', 'codebase-trail', ...args], { cwd: temporary, env: { ...npmEnv, npm_config_loglevel: 'error' }, timeout: 120_000 });
    assert.match(stdout, /^Usage: codebase-trail \[start\|init\]/);
    assert.equal(stderr, '', 'Tarball help must exit before setup or helper discovery');
  }
  const npxCli = join(dirname(npmCli), 'npx-cli.js');
  const npxHelp = await execFile(process.execPath, [npxCli, '--offline', '--yes', `file:${tarball}`, '--help'], { cwd: temporary, env: { ...npmEnv, npm_config_loglevel: 'error' }, timeout: 120_000 });
  assert.match(npxHelp.stdout, /^Usage: codebase-trail \[start\|init\]/);
  assert.equal(npxHelp.stderr, '', 'npx must infer the tarball executable without explicit --package');
  const archive = await readFile(tarball);
  const artifactServer = createHttpServer((request, response) => {
    if (request.url !== `/${packInfo.filename}`) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.length });
    response.end(archive);
  });
  artifactServer.listen(0, '127.0.0.1');
  await once(artifactServer, 'listening');
  try {
    const artifactUrl = `http://127.0.0.1:${artifactServer.address().port}/${packInfo.filename}`;
    const npmVersion = await execFile(process.execPath, [npmCli, '--version'], { env: npmEnv });
    const remotePolicy = Number(npmVersion.stdout.trim().split('.')[0]) >= 12 ? ['--allow-remote=all'] : [];
    const urlEnv = { ...npmEnv, npm_config_loglevel: 'error', npm_config_update_notifier: 'false' };
    await execFile(process.execPath, [npmCli, 'cache', 'add', artifactUrl, '--offline=false', ...remotePolicy], { cwd: temporary, env: urlEnv, timeout: 120_000 });
    const urlHelp = await execFile(process.execPath, [npxCli, '--offline', '--yes', ...remotePolicy, artifactUrl, '--help'], { cwd: temporary, env: urlEnv, timeout: 120_000 });
    assert.match(urlHelp.stdout, /^Usage: codebase-trail \[start\|init\]/);
    assert.equal(urlHelp.stderr, '', 'npx must infer the URL tarball executable with the documented npm remote policy');
    console.log(`URL tarball help passed with npm ${npmVersion.stdout.trim()}${remotePolicy.length ? ' and explicit remote opt-in' : ''}.`);
  } finally {
    artifactServer.closeAllConnections();
    await new Promise((resolve) => artifactServer.close(resolve));
  }
  let output = '';
  launcher = spawn(process.execPath, [installedLauncher, 'init'], {
    cwd: packageDir,
    env: { ...process.env, HOME: temporary, USERPROFILE: temporary, APPDATA: temporary, LOCALAPPDATA: temporary, XDG_CONFIG_HOME: temporary, CODEX_HOME: join(temporary, 'codex'), CLAUDE_CONFIG_DIR: join(temporary, 'claude'), CODEBASE_TRAIL_HOME: join(temporary, 'settings'), CODEBASE_TRAIL_NO_BROWSER: '1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [launcher.stdout, launcher.stderr]) stream.on('data', (chunk) => { output = (output + chunk.toString()).slice(-10_000); });

  const base = `http://127.0.0.1:${port}`;
  let settings;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (launcher.exitCode !== null) throw new Error(`Installed launcher exited before setup opened:\n${output}`);
    try { settings = await fetch(`${base}/settings`); if (settings.ok) break; } catch { /* Optional discovery or cleanup failure does not block this operation. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(settings?.status, 200, `Installed launcher did not open setup:\n${output}`);
  const html = await settings.text();
  assert.match(html, /Set up Codebase Trail|Loading setup/);
  const token = html.match(/const token='([^']+)'/)?.[1];
  assert.ok(token, 'Installed setup must include its API token');
  const response = await fetch(`${base}/api/settings`, { headers: { 'x-code-learning-token': token } });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.setup, true);
  assert.equal(state.checks.find((check) => check.name === 'Native parsers')?.ok, true, 'Packed native parsers must load');
  assert.equal(state.checks.find((check) => check.name === 'npm')?.ok, true, 'Installed setup must find npm');
  console.log(`Installed package opened setup and loaded native parsers on ${process.platform}/${process.arch}.`);
} finally {
  if (launcher && launcher.exitCode === null) {
    launcher.kill();
    await Promise.race([once(launcher, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

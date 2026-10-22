// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import './test-safety.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildReleaseInstallers } from './build-release-installers.mjs';

const execFile = promisify(execFileCallback);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const windows = process.platform === 'win32';
if (!windows && process.platform !== 'darwin') throw new Error('Native bootstrap smoke requires macOS or Windows');
if (!process.env.npm_execpath) throw new Error('Run through npm run test:bootstrap:native');
const temporary = await mkdtemp(join(tmpdir(), 'codebase-trail-native-bootstrap-'));
const home = join(temporary, 'Home with spaces');
const bin = join(temporary, 'download-fixture');
await mkdir(home); await mkdir(bin);
let launcher;
try {
  const packData = JSON.parse((await execFile(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root, timeout: 120_000, env: { ...process.env, npm_config_audit: 'false' } })).stdout);
  const packed = Array.isArray(packData) ? packData[0] : Object.values(packData).find((entry) => entry?.filename);
  assert.ok(packed?.filename, 'npm pack must report its artifact filename');
  const release = await buildReleaseInstallers(temporary, 'migrated-org/practice-app');
  assert.equal(packed.filename, release.artifact);
  const template = await readFile(join(root, 'scripts', windows ? 'install-windows.ps1' : 'install-macos.sh'), 'utf8');
  const nodeVersion = template.match(/(?:NODE_VERSION|\$NodeVersion)\s*=\s*'([^']+)'/)[1];
  const arch = windows || process.arch === 'x64' ? 'x64' : 'arm64';
  const nodeFilename = `node-v${nodeVersion}-${windows ? 'win-x64.zip' : `darwin-${arch}.tar.gz`}`;
  const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeFilename}`;
  const expectedHash = windows ? template.match(/\$NodeSha256\s*=\s*'([a-f0-9]{64})'/)[1]
    : template.match(new RegExp(`${arch === 'arm64' ? 'arm64' : 'x86_64'}\\).*?NODE_SHA256=([a-f0-9]{64})`))[1];
  const nodeArchive = join(temporary, nodeFilename);
  if (process.env.BOOTSTRAP_SMOKE_NODE_ARCHIVE) {
    await writeFile(nodeArchive, await readFile(process.env.BOOTSTRAP_SMOKE_NODE_ARCHIVE));
  } else {
    await execFile(windows ? 'curl.exe' : 'curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--output', nodeArchive, nodeUrl], { timeout: 600_000 });
  }
  assert.equal(createHash('sha256').update(await readFile(nodeArchive)).digest('hex'), expectedHash, 'Official runtime fixture must match the embedded release checksum');
  const appArchive = join(temporary, release.artifact);
  const appUrl = `https://github.com/${release.repository}/releases/download/v${release.version}/${release.artifact}`;
  const quoteShell = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const quotePs = (value) => `'${value.replaceAll("'", "''")}'`;
  let install;
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local'), XDG_CONFIG_HOME: home, GH_CONFIG_DIR: join(home, 'gh'), CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'), NODE_OPTIONS: '', npm_config_audit: 'false' };
  // Only download acquisition is replaced: actual archives, checksums, private Node/npm,
  // app installation, parser checks and activation run unchanged on the native OS.
  if (windows) {
    const harness = join(temporary, 'run-installer.ps1');
    await writeFile(harness, `. ${quotePs(join(temporary, 'install-windows.ps1'))}\nfunction Get-HttpsFile([string]$Url,[string]$Output) {\n if ($Url -eq ${quotePs(nodeUrl)}) { Copy-Item -LiteralPath ${quotePs(nodeArchive)} -Destination $Output }\n elseif ($Url -eq ${quotePs(appUrl)}) { Copy-Item -LiteralPath ${quotePs(appArchive)} -Destination $Output }\n else { throw 'Unexpected fixture URL' }\n}\nInstall-CodebaseTrail -NoLaunch -AppArchive ${quotePs(appArchive)}\n`, 'utf8');
    install = (engine = 'powershell.exe') => execFile(engine, ['-NoLogo', '-NoProfile', '-File', harness], { env, timeout: 600_000 });
  } else {
    await writeFile(join(bin, 'curl'), `#!/bin/bash\nset -eu\nurl=''; output=''\nwhile [ "$#" -gt 0 ]; do case "$1" in https://*) url="$1";; --output) shift; output="$1";; esac; shift; done\ncase "$url" in\n ${quoteShell(nodeUrl)}) cp ${quoteShell(nodeArchive)} "$output";;\n ${quoteShell(appUrl)}) cp ${quoteShell(appArchive)} "$output";;\n *) exit 45;;\nesac\n`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
    install = () => execFile('/bin/bash', [join(temporary, 'install-macos.sh'), '--no-launch', '--app-archive', appArchive], { env, timeout: 600_000 });
  }
  const first = await install(); process.stdout.write(first.stdout);
  const installRoot = windows ? join(env.LOCALAPPDATA, 'CodebaseTrail', 'app') : join(home, 'Library', 'Application Support', 'Codebase Trail', 'app');
  const versions = await readdir(join(installRoot, 'versions'));
  assert.equal(versions.length, 1);
  const destination = join(installRoot, 'versions', versions[0]);
  const privateNode = join(destination, 'node', windows ? 'node.exe' : 'bin/node');
  const privateNpm = join(destination, 'node', windows ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
  assert.equal((await execFile(privateNode, ['--version'], { env })).stdout.trim(), `v${nodeVersion}`);
  assert.match((await execFile(privateNode, [privateNpm, '--version'], { env })).stdout, /^\d+\.\d+\.\d+/);
  const installedLauncher = join(destination, 'app', 'node_modules', 'codebase-trail', 'launcher.mjs');
  assert.match((await execFile(privateNode, [installedLauncher, '--help'], { env })).stdout, /^Usage: codebase-trail/);
  const wrapperPath = join(installRoot, windows ? 'codebase-trail.ps1' : 'codebase-trail');
  const wrapperBytes = await readFile(wrapperPath);
  await install(windows ? 'pwsh' : undefined);
  assert.deepEqual(await readFile(wrapperPath), wrapperBytes, 'Rerun must preserve the working launcher');
  assert.deepEqual(await readdir(join(installRoot, 'versions')), versions);
  assert.ok(!(await readdir(installRoot)).some((name) => name.startsWith('.staging') || name === '.install-lock'));
  const wrapperHelp = await execFile(windows ? 'powershell.exe' : wrapperPath, windows ? ['-NoLogo', '-NoProfile', '-File', wrapperPath, '--help'] : ['--help'], { env, timeout: 30_000 });
  assert.match(wrapperHelp.stdout, /^Usage: codebase-trail/);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  let output = '';
  // A missing private npm must fail rather than fall through to the maintainer/CI npm.
  await writeFile(join(bin, windows ? 'npm.cmd' : 'npm'), windows ? '@echo off\r\nexit /b 91\r\n' : '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  const pathSeparator = windows ? ';' : ':';
  const setupPath = `${bin}${pathSeparator}${env.PATH}`;
  launcher = spawn(windows ? 'powershell.exe' : wrapperPath, windows ? ['-NoLogo', '-NoProfile', '-File', wrapperPath, 'init'] : ['init'], { cwd: temporary, env: { ...env, PATH: setupPath, CODEBASE_TRAIL_HOME: join(home, 'isolated-settings'), CODE_LEARNING_HOME: join(home, 'isolated-settings'), CODEBASE_TRAIL_NO_BROWSER: '1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [launcher.stdout, launcher.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-10_000); });
  let response;
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (launcher.exitCode !== null) throw new Error(`Private runtime launcher exited: ${output}`);
    try { response = await fetch(`${base}/settings`); if (response.ok) break; } catch { /* Loopback startup can precede listening. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(response?.status, 200, output);
  const token = (await response.text()).match(/const token='([^']+)'/)[1];
  const stateResponse = await fetch(`${base}/api/settings`, { headers: { 'x-code-learning-token': token } });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.setup, true);
  assert.equal(state.checks.find((check) => check.name === 'Native parsers')?.ok, true);
  assert.equal(state.checks.find((check) => check.name === 'npm')?.ok, true);
  console.log(`Native bootstrap passed on ${process.platform}/${process.arch}: private Node ${nodeVersion}, npm, rerun, launcher help and setup/native parsers.`);
} finally {
  if (launcher && launcher.exitCode === null) {
    if (windows) await execFile('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], { timeout: 10_000 });
    else launcher.kill();
    await Promise.race([once(launcher, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

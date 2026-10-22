// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import './test-safety.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildReleaseInstallers } from './build-release-installers.mjs';

const execFile = promisify(execFileCallback);
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const onUnix = process.platform !== 'win32';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codebase-trail-bootstrap-test-'));
  const home = join(directory, 'Home with spaces');
  const bin = join(directory, 'fake-bin');
  const root = join(home, 'Library', 'Application Support', 'Codebase Trail', 'app');
  await mkdir(bin); await mkdir(home);
  await writeFile(join(directory, 'codebase-trail-0.1.0.tgz'), 'synthetic app archive');
  await buildReleaseInstallers(directory, 'migrated-org/practice-app');
  await writeFile(join(directory, 'architecture'), 'arm64');
  await writeFile(join(directory, 'os'), 'Darwin');
  await writeFile(join(directory, 'os-version'), '26.0');
  const nodeRoot = join(directory, 'node-fixture');
  await mkdir(join(nodeRoot, 'bin'), { recursive: true });
  await mkdir(join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
  await writeFile(join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '// synthetic npm');
  const privateNode = `#!/bin/bash
set -eu
printf '%s\\n' "$0 $*" >> "$FIXTURE/node-calls"
if [ "$1" = --version ]; then echo v24.22.1; exit 0; fi
case "$1" in
  */npm-cli.js)
    [ ! -f "$FIXTURE/install-fails" ] || exit 41
    while [ "$1" != --prefix ]; do shift; done
    shift; prefix="$1"
    mkdir -p "$prefix/node_modules/codebase-trail"
    printf '// synthetic launcher\\n' > "$prefix/node_modules/codebase-trail/launcher.mjs"
    exit 0 ;;
  --input-type=module) cat >/dev/null; exit 0 ;;
  */launcher.mjs)
    if [ "\${2:-}" = --help ]; then echo 'Usage: codebase-trail [start|init]'; exit 0; fi
    [ ! -d "$HOME/Library/Application Support/Codebase Trail/app/.install-lock" ] || exit 42
    printf 'launched after lock release\\n' >> "$FIXTURE/launched"
    exit 0 ;;
esac
exit 43
`;
  await writeFile(join(nodeRoot, 'bin', 'node'), privateNode, { mode: 0o755 });
  await execFile('tar', ['-czf', join(directory, 'fake-node.tar.gz'), '-C', nodeRoot, '.']);
  const scripts = {
    uname: '#!/bin/sh\ncase "$1" in -s) cat "$FIXTURE/os";; -m) cat "$FIXTURE/architecture";; *) exit 1;; esac\n',
    sw_vers: '#!/bin/sh\ncat "$FIXTURE/os-version"\n',
    git: '#!/bin/sh\n[ ! -f "$FIXTURE/git-missing" ] || exit 1\necho "git version synthetic"\n',
    curl: `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$FIXTURE/downloads"
url=''; output=''
while [ "$#" -gt 0 ]; do case "$1" in https://*) url="$1";; --output) shift; output="$1";; esac; shift; done
case "$url" in
 https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-*.tar.gz) cp "$FIXTURE/fake-node.tar.gz" "$output";;
 https://github.com/migrated-org/practice-app/releases/download/v0.1.0/codebase-trail-0.1.0.tgz)
  [ ! -f "$FIXTURE/asset-missing" ] || exit 22
  if [ -f "$FIXTURE/app-corrupt" ]; then echo corrupt > "$output"; else cp "$FIXTURE/codebase-trail-0.1.0.tgz" "$output"; fi;;
 *) exit 44;;
esac
`,
    shasum: `#!/bin/bash
if [ "$(basename "$3")" = node.tar.gz ]; then
 if [ -f "$FIXTURE/node-corrupt" ]; then printf '%064d  %s\\n' 0 "$3";
 elif [ "$(cat "$FIXTURE/architecture")" = x86_64 ]; then echo "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035  $3";
 else echo "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7  $3"; fi
else exec /usr/bin/shasum "$@"; fi
`,
  };
  for (const [name, body] of Object.entries(scripts)) await writeFile(join(bin, name), body, { mode: 0o755 });
  const env = { ...process.env, HOME: home, FIXTURE: directory, PATH: `${bin}:/usr/bin:/bin` };
  return { directory, home, root, env, run: (args = ['--no-launch']) => execFile('/bin/bash', [join(directory, 'install-macos.sh'), ...args], { env, timeout: 30_000 }), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('release generator binds app hash/version and emits checksum manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codebase-trail-release-test-'));
  try {
    await assert.rejects(buildReleaseInstallers(directory, 'migrated-org/practice-app'), /ENOENT/);
    await writeFile(join(directory, 'codebase-trail-0.1.0.tgz'), 'synthetic first artifact');
    const first = await buildReleaseInstallers(directory, 'migrated-org/practice-app');
    const mac = await readFile(join(directory, 'install-macos.sh'), 'utf8');
    const windows = await readFile(join(directory, 'install-windows.ps1'), 'utf8');
    assert.ok(mac.includes(first.appHash) && windows.includes(first.appHash));
    assert.ok(!mac.includes('__CODEBASE_TRAIL_') && !windows.includes('__CODEBASE_TRAIL_'));
    assert.match(await readFile(join(directory, 'SHA256SUMS'), 'utf8'), /^\w{64} {2}codebase-trail-0\.1\.0\.tgz\n\w{64} {2}install-macos\.sh\n\w{64} {2}install-windows\.ps1\n$/);
    await writeFile(join(directory, 'codebase-trail-0.1.0.tgz'), 'synthetic changed artifact');
    const second = await buildReleaseInstallers(directory, 'migrated-org/practice-app');
    assert.notEqual(first.appHash, second.appHash);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('release repository identity binds both installer URLs without changing app checksum', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codebase-trail-repository-test-'));
  try {
    await writeFile(join(directory, 'codebase-trail-0.1.0.tgz'), 'same app');
    const first = await buildReleaseInstallers(directory, 'first-owner/first-repo');
    for (const file of ['install-macos.sh', 'install-windows.ps1']) {
      const script = await readFile(join(directory, file), 'utf8');
      assert.ok(script.includes('first-owner/first-repo'));
      assert.ok(!script.includes('__CODEBASE_TRAIL_'));
      assert.ok(script.includes(first.appHash));
    }
    for (const repository of ['new-org/.github', 'new-org/_repo', 'new-org/-repo']) {
      const generated = await buildReleaseInstallers(directory, repository);
      assert.equal(generated.repository, repository);
      assert.ok((await readFile(join(directory, 'install-windows.ps1'), 'utf8')).includes(repository));
    }
    const second = await buildReleaseInstallers(directory, 'new-org/new-repo');
    assert.equal(second.appHash, first.appHash);
    for (const file of ['install-macos.sh', 'install-windows.ps1']) {
      const script = await readFile(join(directory, file), 'utf8');
      assert.ok(script.includes('new-org/new-repo'));
      assert.ok(!script.includes('first-owner/first-repo'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing or unsafe repository identity refuses before writing installer files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codebase-trail-invalid-repository-'));
  try {
    await writeFile(join(directory, 'codebase-trail-0.1.0.tgz'), 'same app');
    for (const repository of ['', 'owner', '../repo', 'owner/..', 'owner/.', 'owner/repo/extra', "owner/repo'", 'owner/$(id)', 'owner/repo\\name', '-owner/repo', 'owner-/repo', 'owner/repo\n']) {
      await assert.rejects(buildReleaseInstallers(directory, repository), /repository.*owner\/repo/i);
      assert.deepEqual(await readdir(directory), ['codebase-trail-0.1.0.tgz']);
    }
    const previous = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try { await assert.rejects(buildReleaseInstallers(directory), /repository.*owner\/repo/i); }
    finally { if (previous !== undefined) process.env.GITHUB_REPOSITORY = previous; }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('mac bootstrap installs with no system Node, spaces, private npm, idempotent rerun and lock-free launch', { skip: !onUnix }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(execFile('/bin/bash', ['-c', 'command -v node'], { env: f.env }));
    await f.run();
    const calls = await readFile(join(f.directory, 'node-calls'), 'utf8');
    assert.match(calls, /Home with spaces.*\.staging.*node\/bin\/node.*npm-cli\.js install/);
    for (const flag of ['--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', '--globalconfig']) assert.ok(calls.includes(flag));
    const wrapper = await readFile(join(f.root, 'codebase-trail'), 'utf8');
    assert.match(wrapper, /versions\/v0\.1\.0-/);
    const downloads = await readFile(join(f.directory, 'downloads'), 'utf8');
    await f.run([]);
    assert.equal(await readFile(join(f.directory, 'downloads'), 'utf8'), downloads, 'Completed rerun must not redownload');
    assert.equal(await readFile(join(f.root, 'codebase-trail'), 'utf8'), wrapper);
    assert.match(await readFile(join(f.directory, 'launched'), 'utf8'), /launched after lock release/);
    assert.ok(!(await readdir(f.root)).some((name) => name.startsWith('.staging') || name === '.install-lock'));
  } finally { await f.cleanup(); }
});

test('mac bootstrap accepts a downloaded private app archive without anonymous app access', { skip: !onUnix }, async () => {
  const f = await fixture();
  try {
    const localArchive = join(f.directory, 'private app with spaces.tgz');
    await writeFile(localArchive, await readFile(join(f.directory, 'codebase-trail-0.1.0.tgz')));
    await writeFile(join(f.directory, 'asset-missing'), 'Anonymous app download must not run');
    await f.run(['--no-launch', '--app-archive', localArchive]);
    assert.ok(!(await readFile(join(f.directory, 'downloads'), 'utf8')).includes('github.com'));
    assert.match(await readFile(join(f.root, 'codebase-trail'), 'utf8'), /versions\/v0\.1\.0-/);
    assert.equal(await readFile(localArchive, 'utf8'), 'synthetic app archive');
  } finally { await f.cleanup(); }
});

test('mac bootstrap rejects a corrupt local app archive without activating or executing it', { skip: !onUnix }, async () => {
  const f = await fixture();
  try {
    const localArchive = join(f.directory, 'corrupt app.tgz');
    await writeFile(localArchive, 'corrupt');
    await mkdir(f.root, { recursive: true });
    await writeFile(join(f.root, 'codebase-trail'), 'existing working launcher');
    await assert.rejects(f.run(['--no-launch', '--app-archive', localArchive]), /SHA-256/);
    assert.equal(await readFile(join(f.root, 'codebase-trail'), 'utf8'), 'existing working launcher');
    await assert.rejects(readFile(join(f.directory, 'node-calls')), /ENOENT/);
    assert.ok(!(await readdir(f.root)).some((name) => name.startsWith('.staging') || name === '.install-lock'));
  } finally { await f.cleanup(); }
});

test('mac bootstrap rejects missing local archive arguments and nonfiles before downloading', { skip: !onUnix }, async () => {
  const f = await fixture();
  try {
    for (const args of [['--app-archive'], ['--app-archive', ''], ['--app-archive', join(f.directory, 'absent')], ['--app-archive', f.directory]]) {
      await assert.rejects(f.run(args), /app-archive|app archive/i);
      await assert.rejects(readFile(join(f.directory, 'downloads')), /ENOENT/);
    }
  } finally { await f.cleanup(); }
});

for (const [mode, expected] of [['node-corrupt', /SHA-256/], ['app-corrupt', /SHA-256/], ['asset-missing', /Command failed/], ['install-fails', /Command failed/]]) {
  test(`mac bootstrap ${mode} preserves working launcher and removes staging/lock`, { skip: !onUnix }, async () => {
    const f = await fixture();
    try {
      await mkdir(f.root, { recursive: true });
      await writeFile(join(f.root, 'codebase-trail'), 'existing working launcher');
      await writeFile(join(f.directory, mode), 'failure tripwire');
      await assert.rejects(f.run(), expected);
      assert.equal(await readFile(join(f.root, 'codebase-trail'), 'utf8'), 'existing working launcher');
      assert.ok(!(await readdir(f.root)).some((name) => name.startsWith('.staging') || name === '.install-lock'));
      if (mode === 'node-corrupt' || mode === 'app-corrupt') await assert.rejects(readFile(join(f.directory, 'node-calls')), /ENOENT/);
    } finally { await f.cleanup(); }
  });
}

for (const [file, value, expected] of [['os', 'Linux', /macOS only/], ['os-version', '13.4', /13.5/], ['architecture', 'i386', /architectures/], ['git-missing', '1', /Git is not usable/]]) {
  test(`mac bootstrap rejects ${file} before downloading`, { skip: !onUnix }, async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.directory, file), value);
      await assert.rejects(f.run(), expected);
      await assert.rejects(readFile(join(f.directory, 'downloads')), /ENOENT/);
    } finally { await f.cleanup(); }
  });
}

test('mac bootstrap Intel branch uses pinned x64 runtime', { skip: !onUnix }, async () => {
  const f = await fixture();
  try { await writeFile(join(f.directory, 'architecture'), 'x86_64'); await f.run(); assert.match(await readFile(join(f.directory, 'downloads'), 'utf8'), /darwin-x64\.tar\.gz/); }
  finally { await f.cleanup(); }
});

test('mac bootstrap concurrent lock and incomplete version refuse without modifying existing files', { skip: !onUnix }, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, '.install-lock'), { recursive: true });
    await assert.rejects(f.run(), /install lock/);
    await assert.rejects(readFile(join(f.directory, 'downloads')), /ENOENT/);
    await rm(join(f.root, '.install-lock'), { recursive: true });
    await f.run();
    const version = (await readdir(join(f.root, 'versions')))[0];
    const wrapper = await readFile(join(f.root, 'codebase-trail'));
    await writeFile(join(f.root, 'versions', version, '.complete'), 'wrong marker');
    await assert.rejects(f.run(), /incomplete installation/);
    assert.deepEqual(await readFile(join(f.root, 'codebase-trail')), wrapper);
  } finally { await f.cleanup(); }
});

test('unfilled source templates refuse installation and mac unknown arguments exit2', { skip: !onUnix }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codebase-trail-template-test-'));
  try {
    await assert.rejects(execFile('/bin/bash', [join(source, 'scripts', 'install-macos.sh'), '--no-launch'], { env: { ...process.env, HOME: directory } }), /generated installer/);
    await assert.rejects(execFile('/bin/bash', [join(source, 'scripts', 'install-macos.sh'), '--unknown']), (error) => error.code === 2);
    await assert.rejects(readFile(join(directory, 'Library')), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

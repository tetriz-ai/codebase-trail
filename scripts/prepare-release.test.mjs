// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import './test-safety.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareRelease } from './prepare-release.mjs';
import { releaseDocumentation } from './release-documentation.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
test('local release prepares hash-verified assets for metadata and an explicit migrated destination', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'trail-release-'));
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    for (const repository of [undefined, 'example-org/migrated-app']) {
      const output = join(temporary, repository ? 'explicit' : 'default');
      const release = await prepareRelease(output, repository);
      assert.equal(release.repository, repository || pkg.repository.url.replace('git+https://github.com/', '').replace(/\.git$/, ''));
      assert.equal(release.tag, `v${pkg.version}`);
      assert.equal(release.prerelease, true);
      assert.equal(release.notes, 'release-notes.md');
      assert.ok(release.assets.includes('INSTALL.md'));
      const install = await readFile(join(output, 'INSTALL.md'), 'utf8');
      const notes = await readFile(join(output, release.notes), 'utf8');
      const macosInstaller = await readFile(join(output, 'install-macos.sh'), 'utf8');
      const windowsInstaller = await readFile(join(output, 'install-windows.ps1'), 'utf8');
      const nodeVersion = macosInstaller.match(/^NODE_VERSION='([^']+)'/m)?.[1];
      assert.ok(nodeVersion, 'The generated installer must pin its runtime');
      assert.equal(windowsInstaller.match(/^\$NodeVersion = '([^']+)'/m)?.[1], nodeVersion);
      for (const document of [install, notes, await readFile(join(root, 'docs/coverage.md'), 'utf8')]) {
        assert.ok(document.includes(`Node.js ${nodeVersion}`) || document.includes(`Node ${nodeVersion}`), 'Runtime documentation must match the generated installers');
      }
      assert.ok(install.includes(`https://github.com/${release.repository}/releases/download/${release.tag}/${release.artifact}`));
      assert.ok(install.includes(`--repo ${release.repository}`));
      assert.ok(!install.includes('<!-- release-status:'));
      assert.ok(!install.includes('its source and release assets have not been published yet'));
      assert.ok(notes.includes(`https://github.com/${release.repository}/releases/download/${release.tag}/INSTALL.md`));
      assert.ok(!/private (?:preview|repositor)|public release downloads/i.test(install + notes));
      const cliDownloads = notes.indexOf('### Download with GitHub CLI');
      assert.ok(cliDownloads >= 0 && cliDownloads < notes.indexOf('### URL downloads'));
      assert.ok(install.includes('--app-archive ./codebase-trail-0.1.0.tgz'));
      assert.ok(install.includes('-AppArchive .\\codebase-trail-0.1.0.tgz'));
      assert.ok(notes.includes(`https://github.com/${release.repository}/blob/${release.tag}/docs/coverage.md`));
      assert.ok(!/\]\(\.\.?\//.test(install + notes), 'Release documents must not depend on checkout-relative links');
      for (const line of (await readFile(join(output, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
        const [hash, filename] = line.split('  ');
        assert.equal(createHash('sha256').update(await readFile(join(output, filename))).digest('hex'), hash);
      }
      assert.equal(await readFile(join(output, `${release.artifact}.sha256`), 'utf8'), `${release.appHash}  ${release.artifact}\n`);
      for (const file of ['install-macos.sh', 'install-windows.ps1']) {
        const body = await readFile(join(output, file), 'utf8');
        const variables = file.endsWith('.sh')
          ? { repository: 'APP_REPOSITORY', version: 'APP_VERSION' }
          : { repository: '$AppRepository', version: '$AppVersion' };
        assert.ok(body.includes(`${variables.repository} = '${release.repository}'`) || body.includes(`${variables.repository}='${release.repository}'`));
        assert.ok(body.includes(`${variables.version} = '${release.version}'`) || body.includes(`${variables.version}='${release.version}'`));
        assert.ok(body.includes(release.appHash));
        assert.ok(!body.includes('__CODEBASE_TRAIL_'));
      }
      const bytes = await readFile(join(output, release.artifact));
      await assert.rejects(prepareRelease(output, repository), /must be empty/);
      assert.deepEqual(await readFile(join(output, release.artifact)), bytes);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('release documents follow a new repository and version without stale source URLs', () => {
  const release = { repository: 'new-owner/new-repo', version: '2.3.4-beta.1', artifact: 'codebase-trail-2.3.4-beta.1.tgz' };
  const guide = '<!-- release-status:start -->Old status<!-- release-status:end -->\nhttps://github.com/old-owner/old-repo/releases/download/v0.1.0/codebase-trail-0.1.0.tgz\nRelease `v0.1.0`\n[Model](../README.md#model-access)\n<!-- release-repository:start -->old download instructions<!-- release-repository:end -->';
  const sourceNotes = '# Codebase Trail 2.3.4-beta.1\n\n[Changelog](../../CHANGELOG.md)\n';
  const output = releaseDocumentation(release, guide, sourceNotes, 'old-owner/old-repo');
  assert.ok(!output.installation.includes('old-owner') && !output.installation.includes('v0.1.0'));
  assert.ok(output.installation.includes('/releases/download/v2.3.4-beta.1/codebase-trail-2.3.4-beta.1.tgz'));
  assert.ok(output.installation.includes('--repo new-owner/new-repo'));
  assert.ok(output.notes.includes('/blob/v2.3.4-beta.1/CHANGELOG.md'));
  assert.ok(output.notes.includes('gh release download v2.3.4-beta.1 --repo new-owner/new-repo --dir codebase-trail-download'));
  assert.ok(output.notes.includes('npx --yes ./codebase-trail-2.3.4-beta.1.tgz'));
  assert.throws(() => releaseDocumentation(release, guide, '# Wrong version\n', 'old-owner/old-repo'), /notes must match/);
  assert.throws(() => releaseDocumentation(release, 'missing status', sourceNotes, 'old-owner/old-repo'), /release-status/);
});

test('invalid destinations and inside-checkout outputs fail without packaging', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'trail-release-invalid-'));
  try {
    for (const repository of ['owner/..', 'owner/repo\n', 'owner/$(id)', 'owner']) {
      await assert.rejects(prepareRelease(join(temporary, 'absent'), repository, 'unused-npm-cli'), /safe GitHub/);
      assert.deepEqual(await readdir(temporary), []);
    }
    for (const output of [root, join(root, 'release-output'), join(root, '..assets')]) {
      await assert.rejects(prepareRelease(output, 'example-org/repo', 'unused-npm-cli'), /outside/);
    }
    await symlink(root, join(temporary, 'source-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareRelease(join(temporary, 'source-alias', 'release-output'), 'example-org/repo', 'unused-npm-cli'), /outside/);
    await writeFile(join(temporary, 'preserve'), 'existing asset');
    await assert.rejects(prepareRelease(temporary, 'example-org/repo', 'unused-npm-cli'), /empty/);
    assert.equal(await readFile(join(temporary, 'preserve'), 'utf8'), 'existing asset');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});


test('release workflow preserves an existing release and rejects lookup failures', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'trail-workflow-'));
  try {
    const workflow = await readFile(join(root, '.github/workflows/release.yml'), 'utf8');
    const command = workflow.slice(workflow.indexOf('          if gh api')).split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
    assert.ok(command.startsWith('if gh api'), 'Release publishing must check for existing releases');
    const gh = join(temporary, 'gh');
    await writeFile(gh, `#!/bin/sh
if [ "$1" = api ]; then
  case "$LOOKUP" in
    existing) exit 0 ;;
    missing) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;
    denied) echo 'gh: Unauthorized (HTTP 401)' >&2; exit 1 ;;
  esac
fi
printf '%s\\n' "$*" >> "$CALL_LOG"
`, { mode: 0o700 });
    const log = join(temporary, 'calls');
    for (const lookup of ['existing', 'denied', 'missing']) {
      const run = () => execFileSync('bash', ['-c', command], { env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, LOOKUP: lookup, CALL_LOG: log, GH_REPO: 'example/repository', RELEASE_TAG: 'v0.1.0', RUNNER_TEMP: temporary }, stdio: 'pipe' });
      if (lookup === 'denied') assert.throws(run, /Unauthorized/);
      else run();
      if (lookup !== 'missing') await assert.rejects(readFile(log), { code: 'ENOENT' });
    }
    assert.match(await readFile(log, 'utf8'), /^release create v0.1.0 /);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

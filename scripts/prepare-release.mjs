// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, basename, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildReleaseInstallers } from './build-release-installers.mjs';
import { releaseDocumentation } from './release-documentation.mjs';

const execFile = promisify(execFileCallback);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export async function prepareRelease(directory, repository, npmCli = process.env.npm_execpath) {
  if (!directory || !npmCli) throw new Error('Run npm run release:prepare -- <outside-checkout-directory> [owner/repo]');
  const output = resolve(directory);
  // Resolve existing ancestors so symlinked destinations cannot write inside the source tree.
  let ancestor = output;
  let suffix = '';
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      suffix = join(basename(ancestor), suffix);
      ancestor = dirname(ancestor);
    }
  }
  const canonicalOutput = resolve(ancestor, suffix);
  const inside = relative(await realpath(root), canonicalOutput);
  if (!inside || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) throw new Error('Release output must be outside the source checkout');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const sourceRepository = pkg.repository?.url?.match(/^git\+https:\/\/github\.com\/([^/]+\/[^/]+)\.git$/)?.[1];
  repository ??= sourceRepository;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(repository) || ['.', '..'].includes(repository.split('/')[1])) throw new Error('Release repository must be a safe GitHub owner/repo identity');
  if (pkg.private !== true || pkg.name !== 'codebase-trail' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release manifest');
  const artifact = `codebase-trail-${pkg.version}.tgz`;
  const documents = releaseDocumentation({ repository, version: pkg.version, artifact },
    await readFile(join(root, 'docs', 'install.md'), 'utf8'),
    await readFile(join(root, 'docs', 'releases', `${pkg.version}.md`), 'utf8'), sourceRepository);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Release output must be empty; existing assets will not be overwritten');
  const { stdout } = await execFile(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', output], {
    cwd: root, timeout: 120_000, env: { ...process.env, npm_config_audit: 'false' },
  });
  const packed = JSON.parse(stdout);
  if (!Array.isArray(packed) || packed.length !== 1 || packed[0].filename !== artifact) throw new Error('Unexpected packed release artifact');
  const result = await buildReleaseInstallers(output, repository);
  await writeFile(join(output, `${artifact}.sha256`), `${result.appHash}  ${artifact}\n`);
  await writeFile(join(output, 'INSTALL.md'), documents.installation);
  await writeFile(join(output, 'release-notes.md'), documents.notes);
  const installHash = createHash('sha256').update(documents.installation).digest('hex');
  const checksums = await readFile(join(output, 'SHA256SUMS'), 'utf8');
  await writeFile(join(output, 'SHA256SUMS'), `${checksums}${installHash}  INSTALL.md\n`);
  const assets = [artifact, `${artifact}.sha256`, 'install-macos.sh', 'install-windows.ps1', 'SHA256SUMS', 'INSTALL.md'];
  const release = { ...result, tag: `v${pkg.version}`, prerelease: true, notes: 'release-notes.md', assets };
  await writeFile(join(output, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3 || process.argv.length > 4) throw new Error('Usage: npm run release:prepare -- <outside-checkout-directory> [owner/repo]');
  console.log(JSON.stringify(await prepareRelease(process.argv[2], process.argv[3]), null, 2));
}

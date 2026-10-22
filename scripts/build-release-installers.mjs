// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export async function buildReleaseInstallers(directory, repository = process.env.GITHUB_REPOSITORY) {
  if (typeof repository !== 'string' || repository.trim() !== repository || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.test(repository) || ['.', '..'].includes(repository.split('/')[1])) throw new Error('Release repository must be a safe GitHub owner/repo identity');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'codebase-trail' || pkg.private !== true || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release manifest');
  const output = resolve(directory);
  const artifact = `codebase-trail-${pkg.version}.tgz`;
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const appHash = sha(await readFile(join(output, artifact)));
  const checksums = [`${appHash}  ${artifact}`];
  await mkdir(output, { recursive: true });
  for (const filename of ['install-macos.sh', 'install-windows.ps1']) {
    const template = await readFile(join(root, 'scripts', filename), 'utf8');
    if (!template.includes('__CODEBASE_TRAIL_VERSION__') || !template.includes('__CODEBASE_TRAIL_APP_SHA256__') || !template.includes('__CODEBASE_TRAIL_REPOSITORY__')) throw new Error(`Invalid installer template: ${filename}`);
    const script = template.replaceAll('__CODEBASE_TRAIL_VERSION__', pkg.version).replaceAll('__CODEBASE_TRAIL_APP_SHA256__', appHash).replaceAll('__CODEBASE_TRAIL_REPOSITORY__', repository);
    await writeFile(join(output, filename), script, { mode: 0o644 });
    checksums.push(`${sha(script)}  ${filename}`);
  }
  await writeFile(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  return { version: pkg.version, artifact, appHash, repository };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3 || process.argv.length > 4) throw new Error('Usage: node scripts/build-release-installers.mjs <packed-release-directory> [owner/repo]');
  console.log(JSON.stringify(await buildReleaseInstallers(process.argv[2], process.argv[3])));
}

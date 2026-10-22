// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT

function publishedLinks(markdown, path, repository, tag) {
  const base = `https://github.com/${repository}/blob/${tag}/${path}`;
  return markdown.replace(/\]\(([^)]+)\)/g, (_, link) => {
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(link)) return `](${link})`;
    return `](${new URL(link, base).href})`;
  });
}

export function releaseDocumentation(release, installation, notes, sourceRepository) {
  const { repository, version, artifact } = release;
  const tag = `v${version}`;
  const download = `https://github.com/${repository}/releases/download/${tag}`;
  const status = `These instructions are for Codebase Trail ${tag} from \`${repository}\`.`;
  if (!installation.includes('<!-- release-status:start -->') || !installation.includes('<!-- release-status:end -->')) throw new Error('Installation guide has no release-status section');
  if (!installation.includes('<!-- release-repository:start -->') || !installation.includes('<!-- release-repository:end -->')) throw new Error('Installation guide has no release repository section');
  if (!notes.startsWith(`# Codebase Trail ${version}\n`)) throw new Error('Release notes must match the package version');
  const sourceTag = installation.match(/\/releases\/download\/(v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\//)?.[1];
  if (!sourceTag) throw new Error('Installation guide has no versioned release URLs');
  const install = publishedLinks(installation
    .replace(/<!-- release-status:start -->[\s\S]*?<!-- release-status:end -->/, status)
    .replace(/<!-- release-repository:start -->[\s\S]*?<!-- release-repository:end -->/, `\`\`\`sh\ngh auth login\ngh release download ${tag} --repo ${repository} --dir codebase-trail-download\n\`\`\``)
    .replaceAll(`https://github.com/${sourceRepository}`, `https://github.com/${repository}`)
    .replaceAll(`/releases/download/${sourceTag}/`, `/releases/download/${tag}/`)
    .replaceAll(`\`${sourceTag}\``, `\`${tag}\``)
    .replaceAll(`codebase-trail-${sourceTag.slice(1)}.tgz`, artifact), 'docs/install.md', repository, tag);
  const body = publishedLinks(notes, `docs/releases/${version}.md`, repository, tag)
    + `\n## Install\n\n`
    + `Download the [macOS installer](${download}/install-macos.sh) or [Windows installer](${download}/install-windows.ps1), and verify it against [SHA256SUMS](${download}/SHA256SUMS) before running it. The [installation instructions](${download}/INSTALL.md) include the exact download, verification and launch commands for this release.\n\n`
    + `Installers download a checksum-verified user-local Node.js/npm runtime. Git is required separately; unsigned scripts remain subject to operating-system and organization policies. No administrator access or system PATH changes are requested.\n\n`
    + `### Download with GitHub CLI\n\nSign in with an account that has repository access, then download the assets:\n\n`
    + '```sh\n' + `gh auth login\ngh release download ${tag} --repo ${repository} --dir codebase-trail-download\n` + '```\n\n'
    + `Verify the files against SHA256SUMS and follow INSTALL.md to run an installer with the downloaded app archive. With Node.js 20+ and npm already installed, run the verified local tarball instead:\n\n`
    + '```sh\n' + `cd codebase-trail-download\nnpx --yes ./${artifact}\n` + '```\n\n'
    + `### URL downloads\n\nIf your environment permits direct release URL downloads, download the [app tarball](${download}/${artifact}) and verify it against SHA256SUMS before running it locally. GitHub CLI handles sign-in for the recommended download route above.\n`;
  return { installation: install, notes: body };
}

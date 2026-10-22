# Releases

Codebase Trail ships through GitHub releases. A release includes the app tarball, macOS and Windows installers, checksums and installation instructions; GitHub's automatic source archives are source checkouts and do not include a runtime installation.

The current package version is 0.1.0, a maintained preview. Use its [versioned release notes](releases/0.1.0.md) as the release body; preparing files locally does not create a GitHub release.

## Validate the candidate

Start from the exact source candidate you intend to tag. Keep `private: true` in `package.json`, update its version and create matching `docs/releases/<version>.md` notes before preparing assets.

Install Node.js and npm, then run:

```sh
npm ci --no-audit
npm test
npm run lint
npm run typecheck
npm run test:examples
npm run test:quality
npm run test:bootstrap
npm run test:release
npm run test:install
```

`test:quality` runs coverage, browser tests and the configured mutation gate locally. Install Chromium first as described in [CONTRIBUTING.md](../CONTRIBUTING.md#checks). Repeat the relevant checks on Node.js 20, 24 and 26; run `npm run test:bootstrap:native` on both macOS and Windows before declaring native installers verified.

Use isolated profiles for native checks. They download the pinned runtime and public dependencies, but never call a live model or sign a helper CLI in. Review current advisories for the locked dependencies before each release.

## Prepare the assets

Run this from the source checkout, with an empty output directory outside it:

```sh
npm run release:prepare -- ../codebase-trail-release
```

The destination defaults to `package.json` repository metadata. To prepare assets for another repository, explicitly select its destination:

```sh
npm run release:prepare -- ../codebase-trail-test-release OWNER/REPOSITORY
```

Both installers, `INSTALL.md` and `release-notes.md` use the selected owner/repo. Inspect `release.json` for the repository, version, tag, preview status, app hash, notes filename and complete asset list.

| File | Purpose |
| --- | --- |
| `codebase-trail-<version>.tgz` | App and dependency manifest; npm installs dependencies |
| `codebase-trail-<version>.tgz.sha256` | SHA-256 checksum for the app tarball |
| `install-macos.sh`, `install-windows.ps1` | Install a user-local runtime and the app in the user's folder |
| `SHA256SUMS` | Checksums for the tarball, both installers and `INSTALL.md` |
| `INSTALL.md` | Download, verify and launch instructions for the exact destination |
| `release-notes.md` | Body to paste into the GitHub release |
| `release.json` | Local manifest for reviewing the release; not an installable package |

Existing assets are not overwritten. If preparation fails, inspect and remove only that failed output directory before retrying. An existing publicly published or consumed release must never be replaced with different bytes under the same version.

## Publish manually

After the maintainer approves publication and the candidate is merged, create a GitHub release in the selected repository's Releases page. Use the tag in `release.json`, targeting the exact tested commit, mark the preview as a prerelease, and paste `release-notes.md` into the description.

Upload every filename listed in `release.json`'s `assets`. The local `release.json` and release-note body are review material; neither is a replacement for the tarball or installers. Publishing a GitHub Package or pushing a tag alone does not upload release assets.

Download the published files into a new directory with `gh release download` and verify their checksums before testing the documented commands. Pass the downloaded app tarball to the installer with `--app-archive` or `-AppArchive`, as explained in the [installation guide](install.md#download-with-github-cli).

Confirm that the release tag resolves to the tested source commit and every asset listed in `release.json` is present. Source commits, tags and release assets are separate: pushing source does not upload assets or update a release description. Published releases must retain their original tag and asset bytes; publish a new version when the contents change.

GitHub Actions remains disabled. The checked-in [CI](../.github/workflows/ci.yml) and [release workflow](../.github/workflows/release.yml) are references only: they do not provide hosted validation or publication in this setup. Maintainers must run the validation matrix and manual publication steps above. The retained release workflow leaves an existing release unchanged if it is ever run.

Dependency upgrades are reviewed manually; no Dependabot update configuration is checked in. npm registry publishing remains blocked.

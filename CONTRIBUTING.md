# Contributing

Discuss a change in an issue before adding a new provider or changing the question contract. Follow our [code of conduct](CODE_OF_CONDUCT.md).

For contributor checks, use Node.js 20.19+ on 20.x, 22.13+ on 22.x, or 24+ as required by ESLint 10. The app runtime floor remains Node.js 20. From the repository root, run `npm ci`, `npm test`, and the relevant browser or install smoke test before opening a pull request. Install Chromium with `PLAYWRIGHT_BROWSERS_PATH=/tmp/codebase-trail-playwright npx playwright install chromium` for browser tests.

Keep source and model fixtures synthetic, and keep API keys, repository snapshots, local settings, generated tarballs and private source prompts out of commits. Runtime behavior must not depend on a particular repository ID, organization or checkout layout. Keep custom conventions in explicit extractor plugins and test default behavior with unrelated repository IDs.

## Run from source

For development, use Node.js 24 with npm and install Git separately. Other supported contributor runtimes are listed above. Clone the app source, then install its dependencies and start the browser UI:

```sh
git clone https://github.com/tetriz-ai/codebase-trail.git
cd codebase-trail
npm ci
npm start
```

This checkout contains Codebase Trail itself; choose the repository you want to practice on in Settings. For later launches from this source checkout, run `npm start` again.

## Checks

```sh
npm test
npm run lint
npm run typecheck
npm run test:examples
npm run test:coverage
npm run test:browser
npm run test:install
```

ESLint 10.12.0 checks JavaScript, and TypeScript 7.0.2 uses strict `checkJs` on the extractor SDK and its example. The `typescript` dependency aliases the pinned TypeScript 6.0.2 compatibility library for Stryker, while `@typescript/native` supplies the TypeScript 7 compiler. Keep `@types/node` on the Node.js 20 major so type checking does not admit APIs unavailable at the runtime floor. Behavior changes need a regression test that fails before the change and passes afterward. Tests use isolated profiles, fake helper CLIs and loopback servers, and example output must match its documentation exactly.

## Adding an extractor

The [extractor SDK example](examples/register-extractor/) demonstrates the contributor contract. Follow the [extractor workflow](.claude/skills/add-extractor/SKILL.md) to register a convention, preserve revision-pinned evidence and test unrelated repositories. Settings does not install plugins.

## Reproducing README images

Run `npm run demo:render` after installing Chromium and ffmpeg. It captures the actual learning app with a temporary profile, synthetic committed repository and fixed loopback model, and renders the offline terminal example. No real model, user repository or signed-in helper CLI is used.

## Release artifacts

Follow the [release guide](docs/releases.md) for the local validation matrix, versioned notes, asset generation and manual publication. Keep `private: true` in `package.json`. GitHub Actions remains disabled in repository settings. Workflow files are retained as references only; run the required checks and publication steps manually. npm registry publishing remains blocked. Dependency upgrades are reviewed manually.

`npm run release:prepare -- <outside-checkout-directory> [owner/repo]` creates a tarball, both installers, checksums, `INSTALL.md`, release notes and a review manifest. The destination defaults to package metadata; generated instructions and installer URLs use the selected repository.

The output directory must be empty. A maintainer must approve publication separately; pushing a commit or tag alone does not publish assets.

## Contribution terms

Use a short imperative commit subject that describes the change.

No sign-off line and no separately signed agreement are needed: what you submit in a pull request is offered under the same license as the rest of the project (the [LICENSE](LICENSE)).

Add your name and GitHub username to [CONTRIBUTORS.md](CONTRIBUTORS.md) in your first pull request. Do not include email addresses in that file.

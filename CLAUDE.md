## What this is

Codebase Trail is an npm CLI that starts a local browser app for repository practice.
It validates model questions against committed source evidence and stores learning history.

## Layout

- `launcher.mjs` and `settings-store.mjs`: CLI setup and saved provider policy.
- `server.mjs`: loopback HTTP app, source acquisition and generation orchestration.
- `providers/`: source and model transports, including signed-in CLI adapters.
- `architecture-*.mjs`, `org-graph.mjs`, `syntax-analysis.mjs`: extraction and validation.
- `plugin-sdk.mjs`: contributor extractor contract and strict JavaScript type-check scope.
- `quiz-store.mjs`, `persistent-cache.mjs`: durable history and bounded caches.
- `index.html`, `settings.html`, `ui-logic.mjs`: learning UI and setup.
- Root `*.test.mjs`: offline regression tests; `browser/`: Playwright flows.
- `fixtures/`: synthetic multi-language source repositories.
- `examples/`: complete offline programs and their expected output.
- `scripts/`: quality gates, test safety and shared example session.
- `docs/`: coverage and technical reference; `.github/`: issue templates, optional workflows and visual assets.

## Commands

Node.js 20 is the floor. Run local checks on Node.js 20, 24 and 26.
There is no separate build step. `npm run test:install` packs and installs the release tarball.
Browser tests start their own server on port 4199; leave unrelated listeners alone.
Run `npm ci` first. ESLint 10.12.0 supports Node.js 20.19+ (20.x), 22.13+ (22.x), or 24+. TypeScript 7.0.2 runs `tsc`; its pinned 6.0.2 API compatibility package supports Stryker.
Type checking uses strict `checkJs` on the SDK and its example, not all application code.
Install Chromium with `PLAYWRIGHT_BROWSERS_PATH=/tmp/codebase-trail-playwright npx playwright install chromium`.

```sh
npm ci
npm test
npm run lint
npm run typecheck
npm run test:examples
npm run test:coverage
npm run test:browser
npm run test:install
```

## Contract to keep

- Publish only validated evidence and reviewed candidates (`generation-integration.test.mjs`).
- Keep endpoint authentication and source egress separate (`config.test.mjs`).
- Accept IPv6 loopback and reject nonloopback HTTP (`ipv6-loopback.test.mjs`).
- Reject hostile API origins and missing capability tokens (`http-integration.test.mjs`).
- Never persist raw source or prompts (`quiz-store.test.mjs`, raw payload rejection case).
- Preserve model presets and editable IDs (`browser/settings.spec.mjs`, typed ID cases).
- The listed npm test wrappers preload or import `scripts/test-safety.mjs` before application modules.
- Direct application imports still need that preload so test profiles and helper CLIs are fake.

## Making a change

The package manifest prevents npm registry publishing. Distribution uses GitHub tarballs and checksum-verified user-local runtime installers. Git remains a separate prerequisite.
`npm run release:prepare -- <outside-checkout-directory>` creates local tarballs, installers, checksums and release instructions; follow `docs/releases.md`. Run `npm run test:bootstrap`, and `npm run test:bootstrap:native` on macOS/Windows with isolated profiles; keep artifacts outside the checkout.
Keep runtime URLs/hashes pinned, failed staging separate from working installs, and OS policies intact. Do not push tags or create/upload releases without explicit maintainer approval.

Write a test that fails before a behavior fix and passes afterward.
Put unit cases beside the module and browser interactions in `browser/`.
Add user-visible behavior changes to Unreleased in CHANGELOG.md.
Documentation and tooling changes do not need a changelog entry.
Keep the lint config strict; explain an intentional rule exception in the config, never inline.
The examples runner reads each README's single shell command and compares stdout to its last text block.
It uses no normalization, so avoid timestamps, random IDs and absolute paths in output.
Launcher examples share synthetic Git fixtures and a fixed loopback model in `scripts/example-session.mjs`.
Link each example once in `examples/README.md` using `[name](folder/)`; folder names contain lowercase letters and hyphens.
When adding an example, update the README example count and `scripts/install-smoke.mjs` packed-example list.
The local examples and install smoke tests check the index and README quickstart.

## Do not

- Call real models, helper CLI logins or credential stores from offline tests.
- Remove legacy CODE_LEARNING configuration aliases or settings-directory discovery.
- Treat fixed example model responses as an accuracy measurement.
- Change public command names or defaults as an incidental cleanup.
- Loosen evidence, privacy or output assertions to make a fixture pass.

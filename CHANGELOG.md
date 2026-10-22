# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-22

### Added

- Initial preview release.
- Local browser app for component design, service dependencies, repository topology and merged GitHub pull-request practice, selected in one dropdown.
- Revision-pinned source citations, structured validation and model review before a question is published.
- Saved answers, feedback, notes and portable history for revisiting attempts.
- Preparation details show evidence, generation and review timings and attempt counts to help diagnose slow questions.
- Local model endpoints, supported model APIs and authenticated Claude Code/Codex CLI adapters, with explicit source-egress policies.
- Three complete offline examples and an extractor SDK for extending source conventions.
- GitHub release tarball and checksum-verified macOS/Windows runtime installers, with local asset preparation and manual publication; no npm registry publishing.

### Fixed

- Match credential-variable placeholders to the selected generator and reviewer providers.
- Remove redundant CLI version probes before model calls while retaining explicit installation checks.

### Changed

- Use repository-neutral architecture practice routes, APIs and checkout settings; legacy names remain supported.
- Update the XML parser and development tooling, retaining Node.js 20 declarations and a compiler API compatibility package for mutation testing.

[Unreleased]: https://github.com/tetriz-ai/codebase-trail/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tetriz-ai/codebase-trail/releases/tag/v0.1.0

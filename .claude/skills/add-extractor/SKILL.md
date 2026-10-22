---
name: add-extractor
description: Add a source declaration extractor while preserving revision-pinned evidence and explicit diagnostics.
---

1. Read `plugin-sdk.mjs`, `architecture-extractors.mjs` and the nearest cases in `architecture-extractors.test.mjs`.
2. Write a synthetic supported case and an unsupported or malformed case before adding extraction code.
3. Define the plugin with a stable ID, version, capabilities and a narrow `supports` predicate.
4. Preserve repository ID, revision, file coordinates and content hash in evidence. Register the plugin explicitly through the extractor registry.
5. Update `examples/register-extractor/` only if its demonstrated contract changes. Do not imply Settings installs contributor plugins.
6. Run the commands in `CLAUDE.md`. Add an Unreleased changelog entry for a user-visible new extractor.

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractArchitectureGraph, toOrgInventory } from './architecture-extractors.mjs';
import { buildEvidencePack, buildOrgGraph } from './org-graph.mjs';
import { buildArchitectureLearningInput, compactArchitectureGenerationEvidence, materializeArchitectureEvidence } from './architecture-learning.mjs';

const fixtureRoot = fileURLToPath(new URL('./fixtures/repositories/', import.meta.url));

async function fixtureRepository(name) {
  const root = resolve(fixtureRoot, name); const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const location = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(location);
      else files.push({ path: relative(root, location).replaceAll('\\', '/'), content: await readFile(location, 'utf8'), complete: true });
    }
  }
  await walk(root);
  return { repository_id: `fixture/${name}`, revision: 'fixture-revision-1', tree_complete: true, files };
}

test('checked-in polyglot repository exercises every supported extractor family end to end', async () => {
  const repository = await fixtureRepository('polyglot');
  const extraction = extractArchitectureGraph({ repositories: [repository] });
  assert.equal(extraction.completeness, 'complete');
  for (const resolver of ['go_import', 'node_import', 'python_import', 'rust_use', 'java_import', 'kotlin_import', 'csharp_using', 'ruby_require', 'proto_path', 'sql_table', 'terraform_address', 'compose_service']) {
    assert.ok(extraction.claims.some((claim) => claim.resolver === resolver), resolver);
  }
  const inventory = toOrgInventory(repository, extraction); const graph = buildOrgGraph({ inventories: [inventory], requiredRepoIds: [repository.repository_id] });
  assert.equal(graph.complete, true);
  assert.ok(buildEvidencePack(graph, { scope: 'lld' }).eligible);
  assert.ok(buildEvidencePack(graph, { scope: 'service' }).eligible);
});

test('checked-in negative repository cannot fabricate relationships from comments or strings', async () => {
  const repository = await fixtureRepository('negative');
  const extraction = extractArchitectureGraph({ repositories: [repository] });
  assert.equal(extraction.completeness, 'complete');
  assert.deepEqual(extraction.claims, []);
  assert.ok(!extraction.discoveries.some(({ name }) => /ghost/i.test(name)));
});

test('connected sampling uses resolved imports from every supported language extractor', async () => {
  const polyglot = await fixtureRepository('polyglot');
  const languages = { go: 'go_import', node: 'node_import', python: 'python_import', rust: 'rust_use', java: 'java_import', kotlin: 'kotlin_import', csharp: 'csharp_using', ruby: 'ruby_require' };
  for (const [directory, resolver] of Object.entries(languages)) {
    // Isolate each declared application: the combined fixture intentionally
    // overlaps Java/Kotlin module names and lacks ownership for some folders.
    const repository = {
      ...polyglot, repository_id: `fixture/${directory}`,
      files: [
        ...polyglot.files.filter(({ path }) => path.startsWith(`${directory}/`)).map((file) => ({ ...file, path: file.path.slice(directory.length + 1) })),
        { path: 'docker-compose.yml', content: 'services:\n  fixture:\n    build: .\n', complete: true },
      ],
    };
    const extraction = extractArchitectureGraph({ repositories: [repository] });
    const graph = buildOrgGraph({ inventories: [toOrgInventory(repository, extraction)] });
    const universe = buildEvidencePack(graph, { scope: 'lld' });
    const claims = universe.claims.filter((claim) => claim.mechanism === resolver);
    assert.ok(claims.length, `${resolver} must supply resolved LLD evidence`);
    const ids = new Set(claims.map(({ id }) => id));
    const pack = { ...universe, claims, evidence: universe.evidence.filter(({ claimId }) => ids.has(claimId)) };
    const input = buildArchitectureLearningInput(pack);
    const sampled = compactArchitectureGenerationEvidence(input, materializeArchitectureEvidence(pack, [repository]), { random: () => 0 });
    assert.ok(sampled.input.claims.length, `${resolver} must supply a grounded neighborhood`);
    const reached = new Set([sampled.report.anchor_node_id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const claim of sampled.input.claims) if (reached.has(claim.from) || reached.has(claim.to)) {
        for (const id of [claim.from, claim.to]) if (!reached.has(id)) { reached.add(id); changed = true; }
      }
    }
    assert.ok(sampled.input.claims.every((claim) => reached.has(claim.from) && reached.has(claim.to)), resolver);
  }
});

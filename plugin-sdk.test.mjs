// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineExtractorPlugin, EXTRACTOR_PLUGIN_API_VERSION, extractorPluginManifest, runExtractorPlugin } from './plugin-sdk.mjs';

const plugin = defineExtractorPlugin({ api_version: EXTRACTOR_PLUGIN_API_VERSION, id: 'fixture', version: '1', capabilities: { languages: ['fixture'], file_extensions: ['fx'], claim_kinds: ['imports'] }, supports: ({ path }) => path.endsWith('.fx'), extract: () => ({ discoveries: [], claims: [] }) });
test('absent and malformed definitions explain the required API version', () => {
  for (const definition of [null, undefined, false, 42, 'plugin', [], {}]) {
    assert.throws(() => defineExtractorPlugin(definition), { name: 'TypeError', message: `Extractor plugin api_version must be ${EXTRACTOR_PLUGIN_API_VERSION}.` });
  }
});
test('defines a versioned immutable extractor plugin contract', () => {
  assert.equal(Object.isFrozen(plugin), true);
  assert.equal(Object.isFrozen(plugin.capabilities.languages), true);
  assert.throws(() => plugin.capabilities.languages.push('rust'));
  assert.deepEqual(extractorPluginManifest([plugin])[0], { id: 'fixture', version: '1', api_version: '1.0', capabilities: { languages: ['fixture'], file_extensions: ['fx'], claim_kinds: ['imports'] } });
  assert.throws(() => defineExtractorPlugin({ ...plugin, api_version: '2' }), /api_version/);
});
test('validates plugin result collection shapes', () => {
  assert.deepEqual(runExtractorPlugin(plugin, { path: 'a.fx', content: '' }, { repository_id: 'r', revision: '1' }), { discoveries: [], claims: [] });
  assert.throws(() => runExtractorPlugin(defineExtractorPlugin({ ...plugin, id: 'bad', extract: () => ({ claims: {} }) }), {}, {}), /non-array claims/);
});

test('bounded SDK identifiers, versions and capabilities accept199/200 and reject201', () => {
  for (const length of [199, 200, 201]) {
    for (const field of ['id', 'version']) {
      const candidate = { ...plugin, [field]: 'x'.repeat(length) };
      if (length <= 200) assert.equal(defineExtractorPlugin(candidate)[field].length, length);
      else assert.throws(() => defineExtractorPlugin(candidate), /bounded id and version/);
    }
    for (const field of ['languages', 'file_extensions', 'claim_kinds']) {
      const candidate = { ...plugin, capabilities: { ...plugin.capabilities, [field]: ['x'.repeat(length)] } };
      if (length <= 200) assert.equal(defineExtractorPlugin(candidate).capabilities[field][0].length, length);
      else assert.throws(() => defineExtractorPlugin(candidate), /array of bounded strings/);
    }
  }
  for (const field of ['id', 'version']) for (const value of ['', null, 42]) assert.throws(() => defineExtractorPlugin({ ...plugin, [field]: value }), /bounded id and version/);
  for (const field of ['languages', 'file_extensions', 'claim_kinds']) for (const value of ['not-array', [42], ['']]) assert.throws(() => defineExtractorPlugin({ ...plugin, capabilities: { ...plugin.capabilities, [field]: value } }), /array of bounded strings/);
});

test('SDK cache scope permits only absent or blob', () => {
  assert.equal(defineExtractorPlugin({ ...plugin }).cache_scope, undefined);
  assert.equal(defineExtractorPlugin({ ...plugin, cache_scope: 'blob' }).cache_scope, 'blob');
  for (const cache_scope of [null, '', 'foreign']) assert.throws(() => defineExtractorPlugin({ ...plugin, cache_scope }), /cache_scope must be blob/);
});

test('SDK requires callable hooks and bounded string cache keys', () => {
  for (const field of ['supports', 'extract']) {
    const missing = { ...plugin }; delete missing[field];
    assert.throws(() => defineExtractorPlugin(missing), /supports and extract functions/);
    for (const value of [null, false, 42, 'function', {}]) assert.throws(() => defineExtractorPlugin({ ...plugin, [field]: value }), /supports and extract functions/);
  }
  for (const cache_key of [null, false, 42, [], {}]) assert.throws(() => defineExtractorPlugin({ ...plugin, cache_key }), /cache_key/);
  for (const length of [0, 1999, 2000]) assert.equal(defineExtractorPlugin({ ...plugin, cache_key: 'x'.repeat(length) }).cache_key.length, length);
  assert.throws(() => defineExtractorPlugin({ ...plugin, cache_key: 'x'.repeat(2001) }), /cache_key/);
});

test('malformed synchronous and asynchronous extractor roots fail closed', async () => {
  const { createExtractorRegistry, extractArchitectureGraph } = await import('./architecture-extractors.mjs');
  for (const output of [42, false, 'text', [], Object.assign([], { [Symbol.toStringTag]: 'Object' }), NaN, Infinity, new Date(0), new Map(), new Set(), Promise.resolve({ claims: [] })]) {
    const malformed = defineExtractorPlugin({ ...plugin, extract: () => output });
    assert.throws(() => runExtractorPlugin(malformed, {}, {}), /result object/);
    const graph = extractArchitectureGraph({ repositories: [{ repository_id: 'example/repo', revision: 'abc', tree_complete: true, files: [{ path: 'a.fx', content: '', complete: true }] }], registry: createExtractorRegistry([malformed]) });
    assert.equal(graph.completeness, 'incomplete');
    assert.ok(graph.diagnostics.some(({ code }) => code === 'extractor_failed'));
  }
  for (const output of [undefined, null, {}, { claims: [] }, Object.assign(Object.create(null), { discoveries: [] })]) {
    assert.deepEqual(runExtractorPlugin({ ...plugin, extract: () => output }, {}, {}), output ?? {});
  }
});

test('rejecting async extractors become diagnostics without an unhandled rejection', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = `import assert from 'node:assert/strict';
import { createExtractorRegistry, extractArchitectureGraph } from './architecture-extractors.mjs';
for (const extract of [async () => { throw new Error('synthetic async failure'); }, () => ({ then(resolve, reject) { reject(new Error('synthetic thenable failure')); } })]) {
const plugin = { id: 'async-failure', version: '1', api_version: '1.0', supports: () => true, extract };
const graph = extractArchitectureGraph({ repositories: [{ repository_id: 'example/repo', revision: 'abc', tree_complete: true, files: [{ path: 'a.fx', content: '', complete: true }] }], registry: createExtractorRegistry([plugin]) });
assert.equal(graph.completeness, 'incomplete');
assert.ok(graph.diagnostics.some(({ code }) => code === 'extractor_failed'));
await new Promise((resolve) => setImmediate(resolve));
}
console.log('async failure contained');`;
  assert.equal(execFileSync(process.execPath, ['--import', './scripts/test-safety.mjs', '--unhandled-rejections=strict', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }), 'async failure contained\n');
});

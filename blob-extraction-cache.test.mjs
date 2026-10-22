// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PersistentBlobExtractionCache } from './blob-extraction-cache.mjs';

const key = (value) => createHash('sha256').update(value).digest('hex');
const value = (name) => ({ discoveries: [{ kind: 'component', logical_id: name, name, evidence: [] }], claims: [], service_candidates: [] });

async function cachePath(name = 'blobs.json.gz') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blob-extraction-cache-'));
  return path.join(directory, name);
}

test('persists compressed source-free blob outputs across instances', async () => {
  const filePath = await cachePath(); const first = new PersistentBlobExtractionCache({ filePath, maxEntries: 10 });
  first.set(key('a'), value('a')); await first.flush();
  const second = new PersistentBlobExtractionCache({ filePath, maxEntries: 10 });
  assert.deepEqual(second.get(key('a')), value('a'));
  assert.deepEqual(second.stats, { hits: 1, misses: 0, writes: 0, evictions: 0, flush_failures: 0 });
});

test('enforces an LRU entry bound and returns mutation-isolated copies', async () => {
  const filePath = await cachePath(); const cache = new PersistentBlobExtractionCache({ filePath, maxEntries: 2 });
  cache.set(key('a'), value('a')); cache.set(key('b'), value('b')); cache.get(key('a')); cache.set(key('c'), value('c'));
  const copy = cache.get(key('a')); copy.discoveries[0].name = 'mutated';
  assert.equal(cache.get(key('a')).discoveries[0].name, 'a');
  assert.equal(cache.get(key('b')), undefined);
  await cache.flush();
  const reloaded = new PersistentBlobExtractionCache({ filePath, maxEntries: 2 });
  assert.ok(reloaded.get(key('a'))); assert.ok(reloaded.get(key('c')));
});

test('evicts by serialized weight before flush and backs off after persistence failure', async () => {
  const filePath = await cachePath(); const cache = new PersistentBlobExtractionCache({ filePath, maxEntries: 10, maxBytes: 250 });
  cache.set(key('a'), value('a'.repeat(80))); cache.set(key('b'), value('b'.repeat(80)));
  assert.ok(cache.stats.evictions > 0); await cache.flush();

  let now = 0; const failing = new PersistentBlobExtractionCache({ filePath: '/dev/null/cache.gz', maxEntries: 2, now: () => now });
  failing.set(key('x'), value('x')); await assert.rejects(failing.flush());
  assert.equal(failing.stats.flush_failures, 1); assert.equal(await failing.flush(), false); assert.equal(failing.stats.flush_failures, 1);
});

test('ignores corrupt cache files and validates cache entry shape', async () => {
  const filePath = await cachePath(); await writeFile(filePath, 'not gzip');
  const cache = new PersistentBlobExtractionCache({ filePath, maxEntries: 2 });
  assert.equal(cache.get(key('missing')), undefined);
  assert.throws(() => cache.set('not-a-hash', value('bad')), /Invalid/);
  assert.throws(() => cache.set(key('bad'), { discoveries: [] }), /Invalid/);
});

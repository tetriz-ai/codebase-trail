// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersistentRevisionCache } from "./persistent-cache.mjs";

async function cacheDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "code-learning-cache-"));
}

test("persists a bounded, revision-keyed derived artifact across instances", async () => {
  const directory = await cacheDirectory();
  let now = 100;
  const options = { directory, name: "questions", ttlMs: 1_000, maxEntries: 2, now: () => now, toPersistedValue: (value) => value };
  const first = new PersistentRevisionCache(options);
  await first.set("rev-a", { scope: "hld" }, { question: "How do the boundaries interact?" });
  now++;
  await first.set("rev-b", { scope: "lld" }, { question: "Which contract should own this rule?" });
  now++;
  await first.set("rev-c", { scope: "service" }, { question: "What happens when the dependency fails?" });

  const restarted = new PersistentRevisionCache(options);
  assert.equal(await restarted.get("rev-a", { scope: "hld" }), undefined);
  assert.deepEqual(await restarted.get("rev-c", { scope: "service" }), { question: "What happens when the dependency fails?" });
  assert.equal(await restarted.get("rev-c", { scope: "lld" }), undefined);
});

test("expires entries", async () => {
  const directory = await cacheDirectory();
  let now = 10;
  const cache = new PersistentRevisionCache({ directory, name: "ttl", ttlMs: 5, maxEntries: 2, now: () => now, toPersistedValue: (value) => value });
  await cache.set("revision", {}, { question: "Q" });
  now = 16;
  assert.equal(await cache.get("revision", {}), undefined);
});

test("does not write to disk unless a persistence projection is explicitly supplied", async () => {
  const directory = await cacheDirectory();
  const cache = new PersistentRevisionCache({ directory, name: "memory", maxEntries: 2 });
  await cache.set("revision", {}, { evidence: "raw repository text" });
  assert.deepEqual(await cache.get("revision", {}), { evidence: "raw repository text" });
  await assert.rejects(readFile(path.join(directory, "memory.json")), { code: "ENOENT" });
});

test("refuses raw repository evidence in a persisted projection", async () => {
  const directory = await cacheDirectory();
  const cache = new PersistentRevisionCache({ directory, name: "safe", toPersistedValue: (value) => value });
  await assert.rejects(cache.set("revision", {}, { item: { excerpts: ["secret code"] } }), /sensitive repository field/i);
  await assert.rejects(cache.set("revision", {}, { prompt: "model input" }), /sensitive repository field/i);
});

test("ignores a corrupt cache file and replaces it atomically on the next write", async () => {
  const directory = await cacheDirectory();
  const file = path.join(directory, "recover.json");
  await writeFile(file, "not json");
  const cache = new PersistentRevisionCache({ directory, name: "recover", toPersistedValue: (value) => value });
  assert.equal(await cache.get("revision", {}), undefined);
  await cache.set("revision", {}, { question: "Recovered" });
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
});

test("discards malformed or oversized disk entries before serving them", async () => {
  const directory = await cacheDirectory(); const file = path.join(directory, "guarded.json");
  await writeFile(file, JSON.stringify({ version: 1, entries: [{ key: "not-a-cache-key", touchedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER, value: { question: "tampered" } }] }));
  const malformed = new PersistentRevisionCache({ directory, name: "guarded", toPersistedValue: (value) => value });
  assert.equal(await malformed.get("revision", {}), undefined);
  await writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
  const oversized = new PersistentRevisionCache({ directory, name: "guarded", toPersistedValue: (value) => value });
  assert.equal(await oversized.get("revision", {}), undefined);
});

test('revision boundaries199/200/201 are enforced on both writes and reads', async () => {
  const directory = await cacheDirectory();
  const cache = new PersistentRevisionCache({ directory, name: 'revision-boundaries' });
  for (const length of [199, 200]) {
    const revision = 'r'.repeat(length);
    await cache.set(revision, {}, { question: `Revision length ${length}` });
    assert.deepEqual(await cache.get(revision), { question: `Revision length ${length}` });
  }
  for (const revision of ['r'.repeat(201), '', null, 123]) {
    await assert.rejects(cache.set(revision, {}, { question: 'Rejected' }), /revision string/);
    await assert.rejects(cache.get(revision), /revision string/);
  }
});

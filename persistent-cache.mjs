// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FORMAT_VERSION = 1;
const MAX_CACHE_FILE_BYTES = 2 * 1024 * 1024;
const SENSITIVE_KEYS = /(?:^|_)(?:code|contents?|diff|evidence|excerpts?|patch|prompts?|raw|source_(?:code|content|text))(?:$|_)/i;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSafePersistedValue(value, trail = []) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`Persisted cache value is not JSON-safe at ${trail.join(".") || "<root>"}`);
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafePersistedValue(entry, [...trail, String(index)]));
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`Persisted cache value must contain plain objects at ${trail.join(".") || "<root>"}`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key)) {
      throw new Error(`Refusing to persist sensitive repository field: ${[...trail, key].join(".")}`);
    }
    assertSafePersistedValue(entry, [...trail, key]);
  }
}

function cacheKey(revision, dimensions) {
  if (typeof revision !== "string" || !revision || revision.length > 200) {
    throw new TypeError("A non-empty revision string (maximum 200 characters) is required");
  }
  return createHash("sha256").update(stableJson({ revision, dimensions })).digest("hex");
}

/**
 * A small revision-scoped cache with an optional, deliberately narrow disk tier.
 *
 * `toPersistedValue` is the security boundary: without it the cache is memory-only.
 * Its result is also rejected when it contains raw-evidence-shaped field names.
 * Persist only derived/public artifacts (for example a published question), never
 * repository excerpts, prompts, diffs, or model inputs.
 */
export class PersistentRevisionCache {
  constructor({ directory, name, ttlMs = 24 * 60 * 60 * 1000, maxEntries = 100, toPersistedValue, now = Date.now }) {
    if (!directory || !name || !/^[a-zA-Z0-9_.-]+$/.test(name)) throw new TypeError("Safe cache directory and name are required");
    if (!(ttlMs > 0) || !(maxEntries > 0)) throw new TypeError("ttlMs and maxEntries must be positive");
    this.file = path.join(directory, `${name}.json`);
    this.directory = directory;
    this.ttlMs = ttlMs;
    this.maxEntries = Math.floor(maxEntries);
    this.toPersistedValue = toPersistedValue;
    this.now = now;
    this.memory = new Map();
    this.disk = new Map();
    this.ready = this.#load();
    this.writeChain = Promise.resolve();
  }

  async #load() {
    try {
      const handle = await open(this.file, "r");
      let body;
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_CACHE_FILE_BYTES) return;
        body = await handle.readFile("utf8");
      } finally { await handle.close(); }
      const parsed = JSON.parse(body);
      if (parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.entries)) return;
      const now = this.now();
      for (const entry of parsed.entries.slice(0, this.maxEntries)) {
        try {
          if (!/^[a-f0-9]{64}$/.test(entry?.key) || !Number.isFinite(entry?.expiresAt) || !Number.isFinite(entry?.touchedAt) || entry.expiresAt <= now) continue;
          assertSafePersistedValue(entry.value);
          this.disk.set(entry.key, entry);
        } catch { /* A local cache is disposable when its shape is invalid. */ }
      }
      this.#trim(this.disk);
    } catch (error) {
      if (error?.code !== "ENOENT") this.disk.clear(); // Corrupt cache is disposable.
    }
  }

  #trim(map) {
    const ordered = [...map.values()].sort((a, b) => b.touchedAt - a.touchedAt);
    map.clear();
    for (const entry of ordered.slice(0, this.maxEntries)) map.set(entry.key, entry);
  }

  async get(revision, dimensions = {}) {
    await this.ready;
    const key = cacheKey(revision, dimensions);
    const now = this.now();
    const memoryEntry = this.memory.get(key);
    if (memoryEntry?.expiresAt > now) {
      memoryEntry.touchedAt = now;
      return memoryEntry.value;
    }
    this.memory.delete(key);
    const diskEntry = this.disk.get(key);
    if (!diskEntry || diskEntry.expiresAt <= now) {
      this.disk.delete(key);
      return undefined;
    }
    diskEntry.touchedAt = now;
    return diskEntry.value;
  }

  async set(revision, dimensions, value) {
    await this.ready;
    const key = cacheKey(revision, dimensions);
    const touchedAt = this.now();
    const expiresAt = touchedAt + this.ttlMs;
    let safeCopy;
    if (this.toPersistedValue) {
      const persisted = await this.toPersistedValue(value);
      if (persisted !== undefined) {
        assertSafePersistedValue(persisted);
        // JSON round-trip prevents later caller mutation and verifies serialization.
        safeCopy = JSON.parse(JSON.stringify(persisted));
      }
    }
    this.memory.set(key, { key, value, touchedAt, expiresAt });
    this.#trim(this.memory);
    if (safeCopy !== undefined) {
      this.disk.set(key, { key, value: safeCopy, touchedAt, expiresAt });
      this.#trim(this.disk);
      await this.#scheduleWrite();
    }
    return value;
  }

  async #scheduleWrite() {
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      const body = JSON.stringify({ version: FORMAT_VERSION, entries: [...this.disk.values()] });
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.writeChain;
  }
}

export const persistentCacheInternals = { cacheKey, assertSafePersistedValue };

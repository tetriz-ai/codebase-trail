// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createGzip, gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const FORMAT_VERSION = 1;
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const KEY_PATTERN = /^[a-f0-9]{64}$/;

const plainJson = (value) => JSON.parse(JSON.stringify(value));

function validEntry(key, value) {
  return KEY_PATTERN.test(key)
    && value && typeof value === 'object' && !Array.isArray(value)
    && ['discoveries', 'claims', 'service_candidates'].every((field) => Array.isArray(value[field]));
}

/**
 * Disposable, source-free disk cache for deterministic per-blob extractor output.
 * Map insertion order is the LRU order; the complete cache is flushed once per
 * repository analysis rather than rewritten for every blob.
 */
export class PersistentBlobExtractionCache {
  constructor({ filePath, maxEntries = 50_000, maxBytes = 24 * 1024 * 1024, now = Date.now } = {}) {
    if (!filePath || !Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxBytes) || maxBytes < 1) throw new TypeError('A cache file path and positive maxEntries/maxBytes are required.');
    this.filePath = filePath; this.maxEntries = maxEntries; this.maxBytes = Math.min(maxBytes, MAX_UNCOMPRESSED_BYTES); this.now = now; this.entries = new Map(); this.entryBytes = new Map(); this.dirty = false; this.flushPromise = Promise.resolve(); this.backoffUntil = 0;
    this.stats = { hits: 0, misses: 0, writes: 0, evictions: 0, flush_failures: 0 };
    this.#load();
  }

  #load() {
    try {
      if (!existsSync(this.filePath)) return;
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_COMPRESSED_BYTES) return;
      const compressed = readFileSync(this.filePath);
      const body = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES }).toString('utf8');
      const parsed = JSON.parse(body);
      if (parsed?.version !== FORMAT_VERSION || !Array.isArray(parsed.entries)) return;
      for (const pair of parsed.entries.slice(-this.maxEntries)) {
        if (!Array.isArray(pair) || pair.length !== 2 || !validEntry(pair[0], pair[1])) continue;
        this.entries.set(pair[0], pair[1]); this.entryBytes.set(pair[0], Buffer.byteLength(JSON.stringify(pair)));
      }
      this.#evict();
    } catch { this.entries.clear(); this.entryBytes.clear(); }
  }

  get(key) {
    const value = this.entries.get(key);
    if (!value) { this.stats.misses += 1; return undefined; }
    this.entries.delete(key); this.entries.set(key, value); this.stats.hits += 1;
    return plainJson(value);
  }

  set(key, value) {
    if (!validEntry(key, value)) throw new TypeError('Invalid source-free blob extraction cache entry.');
    const copy = plainJson(value);
    this.entries.delete(key); this.entryBytes.delete(key); this.entries.set(key, copy); this.entryBytes.set(key, Buffer.byteLength(JSON.stringify([key, copy]))); this.dirty = true; this.stats.writes += 1;
    this.#evict();
  }

  #evict() {
    let bytes = [...this.entryBytes.values()].reduce((total, value) => total + value, 0);
    while (this.entries.size > this.maxEntries || bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value; if (oldest === undefined) break;
      bytes -= this.entryBytes.get(oldest) ?? 0; this.entries.delete(oldest); this.entryBytes.delete(oldest); this.stats.evictions += 1;
    }
  }

  flush() {
    if (this.now() < this.backoffUntil) return Promise.resolve(false);
    if (!this.dirty) return this.flushPromise.then(() => false, () => false);
    const entries = [...this.entries]; this.dirty = false;
    this.flushPromise = this.flushPromise.catch(() => {}).then(async () => {
      const directory = path.dirname(this.filePath); await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      let uncompressedBytes = 0;
      const chunks = async function* () {
        const emit = (chunk) => {
          uncompressedBytes += Buffer.byteLength(chunk);
          if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new RangeError('Blob extraction cache exceeds its uncompressed size limit.');
          return chunk;
        };
        yield emit(`{"version":${FORMAT_VERSION},"entries":[`);
        for (let index = 0; index < entries.length; index += 1) yield emit(`${index ? ',' : ''}${JSON.stringify(entries[index])}`);
        yield emit(']}');
      };
      try {
        await pipeline(Readable.from(chunks()), createGzip({ level: 6 }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        if ((await stat(temporary)).size > MAX_COMPRESSED_BYTES) throw new RangeError('Blob extraction cache exceeds its compressed size limit.');
        await rename(temporary, this.filePath);
      }
      finally { try { await unlink(temporary); } catch { /* Atomic rename or cleanup already removed it. */ } }
      return true;
    }).catch((error) => { this.dirty = true; this.stats.flush_failures += 1; this.backoffUntil = this.now() + 60_000; throw error; });
    return this.flushPromise;
  }
}

export const blobExtractionCacheInternals = Object.freeze({ FORMAT_VERSION, MAX_COMPRESSED_BYTES, MAX_UNCOMPRESSED_BYTES });

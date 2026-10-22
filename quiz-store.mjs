// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const QUIZ_STORE_SCHEMA_VERSION = 1;
export const QUESTION_STATES = Object.freeze([
  'draft', 'reviewed', 'published', 'answered', 'scheduled_for_review', 'retired',
]);

const QUESTION_STATE_SET = new Set(QUESTION_STATES);
const TRANSITIONS = Object.freeze({
  draft: new Set(['reviewed', 'retired']),
  reviewed: new Set(['draft', 'published', 'retired']),
  published: new Set(['answered', 'retired']),
  answered: new Set(['scheduled_for_review', 'retired']),
  scheduled_for_review: new Set(['answered', 'retired']),
  retired: new Set(),
});
const RAW_PAYLOAD_KEYS = new Set([
  'content', 'raw_source', 'source_content', 'source_text', 'patch', 'diff',
  'prompt', 'system_prompt', 'developer_prompt', 'messages', 'evidence_bundle',
  'body', 'excerpt', 'excerpts', 'input', 'inputs', 'input_sources', 'source_code',
]);
const RECORD_KEYS = new Set(['id', 'question', 'choices', 'answer', 'evidence_pin', 'state', 'metadata', 'explanation', 'question_fingerprint', 'evidence_fingerprint', 'attempts', 'first_attempt', 'review_count', 'next_review_at', 'created_at', 'updated_at']);
const METADATA_KEYS = new Set(['scope', 'source_pr', 'model', 'saved_at']);
const ATTEMPT_KEYS = new Set(['selected', 'correct', 'selected_option_id', 'was_correct', 'revealed_without_answer', 'feedback', 'attempt_id', 'attempted_at']);
const FEEDBACK_KEYS = new Set(['subjective', 'helpfulness', 'relevance', 'learning_outcome', 'limiting_reasons']);
const DEFAULT_REVIEW_INTERVALS_MS = Object.freeze([
  24 * 60 * 60 * 1000,
  3 * 24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  14 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
]);

export class QuizStoreLimitError extends Error {
  constructor(limit) {
    super(`Quiz store record limit (${limit}) reached.`);
    this.name = 'QuizStoreLimitError';
  }
}

export class QuizStoreValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuizStoreValidationError';
  }
}

export class QuizStoreCorruptionError extends Error {
  constructor(cause) {
    super('Durable history is unreadable. Preserve the history files and repair or restore them from a trusted backup before retrying.', { cause });
    this.name = 'QuizStoreCorruptionError';
    this.code = 'history_store_corrupt';
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function questionFingerprint(question) {
  const material = typeof question === 'string' ? question : {
    question: question?.question,
    choices: question?.choices || question?.options || null,
    answer: question?.answer ?? null,
  };
  if (!material || (typeof material === 'object' && !material.question)) {
    throw new QuizStoreValidationError('A question is required to calculate its fingerprint.');
  }
  return fingerprint(material);
}

export function evidenceFingerprint(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    throw new QuizStoreValidationError('Evidence metadata is required to calculate its fingerprint.');
  }
  return fingerprint(evidence);
}

function clone(value) {
  return structuredClone(value);
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function emptyDocument(now) {
  return {
    schema_version: QUIZ_STORE_SCHEMA_VERSION,
    created_at: now,
    updated_at: now,
    records: [],
  };
}

function assertNoRawPayload(value, path = '$', depth = 0, portableDocument = false) {
  if (depth > 12) throw new QuizStoreValidationError(`Portable history is too deeply nested at ${path}.`);
  if (typeof value === 'string' && value.length > 8_000) throw new QuizStoreValidationError(`Portable history string exceeds 8,000 characters at ${path}.`);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    // Only document records use the store capacity; nested arrays retain their bound.
    const documentRecords = portableDocument && depth === 1 && (path === '$.records' || (portableDocument === 'questions' && path === '$.questions'));
    if (!documentRecords && value.length > 250) throw new QuizStoreValidationError(`Portable history array exceeds 250 entries at ${path}.`);
    value.forEach((item, index) => assertNoRawPayload(item, `${path}[${index}]`, documentRecords ? 0 : depth + 1, portableDocument));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (RAW_PAYLOAD_KEYS.has(key.toLowerCase())) {
      throw new QuizStoreValidationError(`Raw source or prompt field is not portable: ${path}.${key}.`);
    }
    assertNoRawPayload(child, `${path}.${key}`, depth + 1, portableDocument);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  if (value === null || value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new QuizStoreValidationError(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new QuizStoreValidationError(`Unsupported ${label} field: ${key}.`);
}

function assertRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new QuizStoreValidationError('Quiz record must be an object.');
  rejectUnknownKeys(record, RECORD_KEYS, 'quiz record');
  if (!record.id || typeof record.question !== 'string' || !record.question.trim() || record.question.length > 2_000) throw new QuizStoreValidationError('Quiz record requires a bounded string id and question.');
  if (!record.question_fingerprint || !record.evidence_fingerprint) throw new QuizStoreValidationError('Quiz record requires question and evidence fingerprints.');
  if (!QUESTION_STATE_SET.has(record.state)) throw new QuizStoreValidationError(`Unsupported question state: ${record.state}.`);
  if (!Array.isArray(record.attempts)) throw new QuizStoreValidationError('Quiz record attempts must be an array.');
  if (record.attempts.length > 250) throw new QuizStoreValidationError('Quiz record has too many attempts.');
  rejectUnknownKeys(record.metadata, METADATA_KEYS, 'metadata');
  if (record.metadata?.source_pr) rejectUnknownKeys(record.metadata.source_pr, new Set(['number', 'title', 'url']), 'source_pr');
  for (const attempt of [...record.attempts, ...(record.first_attempt ? [record.first_attempt] : [])]) {
    rejectUnknownKeys(attempt, ATTEMPT_KEYS, 'attempt');
    rejectUnknownKeys(attempt.feedback, FEEDBACK_KEYS, 'feedback');
  }
  assertNoRawPayload(record);
  if (Buffer.byteLength(JSON.stringify(record)) > 128 * 1024) throw new QuizStoreValidationError('Quiz record exceeds the 128 KiB portable limit.');
}

function validateDocument(document, maxRecords = Infinity) {
  if (!document || document.schema_version !== QUIZ_STORE_SCHEMA_VERSION || !Array.isArray(document.records)) {
    throw new QuizStoreValidationError('Unsupported or malformed quiz store document.');
  }
  if (document.records.length > maxRecords) throw new QuizStoreLimitError(maxRecords);
  const ids = new Set();
  const dedupe = new Set();
  for (const record of document.records) {
    assertRecord(record);
    if (ids.has(record.id)) throw new QuizStoreValidationError(`Duplicate quiz record id: ${record.id}.`);
    ids.add(record.id);
    const key = `${record.evidence_fingerprint}:${record.question_fingerprint}`;
    if (dedupe.has(key)) throw new QuizStoreValidationError('Duplicate evidence/question fingerprint pair.');
    dedupe.add(key);
  }
  return document;
}

// This deliberately centralizes migrations. Future schema versions add one
// pure migration to this map instead of spreading compatibility logic through
// reads and imports.
const MIGRATIONS = new Map([
  [0, (document, now) => ({
    schema_version: 1,
    created_at: document.created_at || now,
    updated_at: document.updated_at || now,
    records: document.records ?? document.questions,
  })],
]);

export function migrateQuizStoreDocument(input, { now = new Date().toISOString() } = {}) {
  let document = clone(input);
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new QuizStoreValidationError('Unsupported or malformed quiz store document.');
  }
  const hasVersion = Object.hasOwn(document, 'schema_version');
  if (hasVersion && (!Number.isInteger(document.schema_version) || document.schema_version < 0)) {
    throw new QuizStoreValidationError('Unsupported or malformed quiz store schema version.');
  }
  let version = hasVersion ? document.schema_version : 0;
  if (version === 0) {
    const fields = ['records', 'questions'].filter(key => Object.hasOwn(document, key));
    if (!fields.length || fields.some(key => !Array.isArray(document[key]))) {
      throw new QuizStoreValidationError('Legacy quiz store requires a records or questions array.');
    }
  }
  if (version > QUIZ_STORE_SCHEMA_VERSION) {
    throw new QuizStoreValidationError(`Quiz store schema ${version} is newer than supported schema ${QUIZ_STORE_SCHEMA_VERSION}.`);
  }
  while (version < QUIZ_STORE_SCHEMA_VERSION) {
    const migration = MIGRATIONS.get(version);
    if (!migration) throw new QuizStoreValidationError(`No quiz store migration from schema ${version}.`);
    document = migration(document, now);
    version = document.schema_version;
  }
  return document;
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function atomicWrite(path, value, { preservePrevious = true } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const temporary = `${path}.${nonce}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (preservePrevious && await exists(path)) {
    const backupTemporary = `${path}.${nonce}.bak.tmp`;
    await copyFile(path, backupTemporary);
    await rename(backupTemporary, `${path}.bak`);
  }
  await rename(temporary, path);
  try {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  }
}

function prepareNewRecord(input, now) {
  assertNoRawPayload(input);
  const questionFp = input.question_fingerprint || questionFingerprint(input);
  const evidenceFp = input.evidence_fingerprint || evidenceFingerprint(input.evidence_pin || input.evidence);
  const record = {
    ...clone(input),
    id: input.id || randomUUID(),
    state: input.state || 'draft',
    question_fingerprint: questionFp,
    evidence_fingerprint: evidenceFp,
    attempts: [],
    first_attempt: null,
    review_count: 0,
    next_review_at: null,
    created_at: now,
    updated_at: now,
  };
  delete record.evidence;
  assertRecord(record);
  return record;
}

export function createQuizStore({ filePath, maxRecords = 1000, now = () => new Date(), reviewIntervalsMs = DEFAULT_REVIEW_INTERVALS_MS } = {}) {
  if (!filePath) throw new QuizStoreValidationError('filePath is required.');
  if (!Number.isInteger(maxRecords) || maxRecords < 1) throw new QuizStoreValidationError('maxRecords must be a positive integer.');
  if (!Array.isArray(reviewIntervalsMs) || !reviewIntervalsMs.length || reviewIntervalsMs.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new QuizStoreValidationError('reviewIntervalsMs must contain non-negative durations.');
  }
  let document;
  let mutationTail = Promise.resolve();
  let canonicalPath;
  const timestamp = () => iso(now());

  async function withFileLock(operation) {
    if (!canonicalPath) {
      const supplied = resolve(filePath);
      await mkdir(dirname(supplied), { recursive: true });
      try { canonicalPath = await realpath(supplied); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        canonicalPath = join(await realpath(dirname(supplied)), basename(supplied));
      }
    }
    filePath = canonicalPath;
    const lockPath = `${filePath}.lock`;
    const ownerPath = join(lockPath, 'owner.json');
    const token = randomUUID();
    const deadline = Date.now() + 2_000;
    while (true) {
      try { await mkdir(lockPath, { mode: 0o700 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) {
          const busy = new Error('Durable history is locked by another operation. Retry after it finishes. If an app was interrupted, stop every Codebase Trail process before manually removing the history file’s .lock directory; preserve the history and backup files.');
          busy.code = 'history_store_busy';
          throw busy;
        }
        await delay(10);
      }
    }
    // No automatic stale-lock recovery: checking a PID and then deleting or
    // renaming a lock could remove a new owner's lock after a competing recovery.
    try { await writeFile(ownerPath, JSON.stringify({ token, pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { try { await rmdir(lockPath); } catch { /* Preserve ambiguous ownership. */ } throw error; }
    const release = async () => {
      const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
      if (owner.token !== token) throw new Error('Durable history lock ownership changed; preserve the history files and stop all writers.');
      await unlink(ownerPath);
      await rmdir(lockPath);
    };
    try {
      document = undefined;
      await load();
      return await operation();
    } finally {
      await release();
    }
  }

  async function read(operation) {
    await mutationTail;
    return withFileLock(() => clone(operation(document)));
  }

  async function parseDocument(path) {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return validateDocument(migrateQuizStoreDocument(parsed, { now: timestamp() }), maxRecords);
  }

  async function load() {
    if (document) return document;
    if (!await exists(filePath)) {
      document = emptyDocument(timestamp());
      await atomicWrite(filePath, document, { preservePrevious: false });
      return document;
    }
    try {
      document = await parseDocument(filePath);
      return document;
    } catch (primaryError) {
      let recovered;
      try { recovered = await parseDocument(`${filePath}.bak`); }
      catch { throw new QuizStoreCorruptionError(primaryError); }
      // Recovery never discards the corrupt original; keep an exclusive private copy for repair.
      const recoveryPath = `${filePath}.corrupt-${Date.now()}-${randomUUID()}`;
      const handle = await open(recoveryPath, 'wx', 0o600);
      try { await handle.writeFile(await readFile(filePath)); await handle.sync(); }
      finally { await handle.close(); }
      await atomicWrite(filePath, recovered, { preservePrevious: false });
      document = recovered;
      return document;
    }
  }

  function mutate(operation) {
    const pending = mutationTail.then(() => withFileLock(async () => {
      const next = clone(document);
      const result = await operation(next);
      next.updated_at = timestamp();
      validateDocument(next, maxRecords);
      await atomicWrite(filePath, next);
      document = next;
      return clone(result);
    }));
    mutationTail = pending.catch(() => {});
    return pending;
  }

  function findRecord(next, id) {
    const record = next.records.find((candidate) => candidate.id === id);
    if (!record) throw new QuizStoreValidationError(`Unknown quiz record: ${id}.`);
    return record;
  }

  function appendRecord(next, input) {
    const prepared = prepareNewRecord(input, timestamp());
    const duplicate = next.records.find((record) => record.question_fingerprint === prepared.question_fingerprint && record.evidence_fingerprint === prepared.evidence_fingerprint);
    if (duplicate) return { created: false, duplicate: true, record: duplicate };
    if (next.records.length >= maxRecords) throw new QuizStoreLimitError(maxRecords);
    next.records.push(prepared);
    return { created: true, duplicate: false, record: prepared };
  }

  function recordAttempt(next, id, attempt) {
    assertNoRawPayload(attempt);
    const record = findRecord(next, id);
    if (attempt?.attempt_id && record.attempts.some(({ attempt_id }) => attempt_id === attempt.attempt_id)) return record;
    if (!['published', 'scheduled_for_review'].includes(record.state)) {
      throw new QuizStoreValidationError(`Cannot answer a question in ${record.state} state.`);
    }
    const attemptedAt = timestamp();
    const storedAttempt = { ...clone(attempt), attempted_at: attempt.attempted_at ? iso(attempt.attempted_at) : attemptedAt };
    record.attempts.push(storedAttempt);
    if (!record.first_attempt) record.first_attempt = clone(storedAttempt);
    record.review_count += 1;
    record.state = 'answered';
    record.next_review_at = null;
    record.updated_at = attemptedAt;
    return record;
  }

  function updateFeedback(next, id, attemptId, feedback) {
    assertNoRawPayload(feedback);
    rejectUnknownKeys(feedback, FEEDBACK_KEYS, 'feedback');
    const record = findRecord(next, id);
    const attempt = record.attempts.find((entry) => entry.attempt_id === attemptId);
    if (!attempt) throw new QuizStoreValidationError('Attempt to update was not found.');
    attempt.feedback = clone(feedback);
    if (record.first_attempt?.attempt_id === attemptId) record.first_attempt.feedback = clone(feedback);
    record.updated_at = timestamp();
    assertRecord(record);
    return record;
  }

  function scheduleReview(next, id, at) {
    const record = findRecord(next, id);
    if (record.state !== 'answered' && record.state !== 'scheduled_for_review') {
      throw new QuizStoreValidationError(`Cannot schedule review from ${record.state} state.`);
    }
    const interval = reviewIntervalsMs[Math.min(record.review_count, reviewIntervalsMs.length - 1)];
    record.next_review_at = at ? iso(at) : new Date(new Date(timestamp()).getTime() + interval).toISOString();
    record.state = 'scheduled_for_review';
    record.updated_at = timestamp();
    return record;
  }
  return Object.freeze({
    async initialize() { return read((current) => current); },

    async get(id) {
      return read((current) => current.records.find((candidate) => candidate.id === id) || null);
    },

    async list({ state, question_fingerprint, evidence_fingerprint, query, limit = 100, offset = 0 } = {}) {
      for (const [name, value] of Object.entries({ limit, offset })) {
        if (!Number.isSafeInteger(value) || value < 0) throw new QuizStoreValidationError(`${name} must be a nonnegative safe integer.`);
      }
      if (state && !QUESTION_STATE_SET.has(state)) throw new QuizStoreValidationError(`Unsupported question state: ${state}.`);
      return read((current) => {
        let records = current.records;
        if (state) records = records.filter((record) => record.state === state);
        if (question_fingerprint) records = records.filter((record) => record.question_fingerprint === question_fingerprint);
        if (evidence_fingerprint) records = records.filter((record) => record.evidence_fingerprint === evidence_fingerprint);
        if (query) records = records.filter((record) => record.question.toLowerCase().includes(String(query).toLowerCase()));
        records = [...records].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
        return records.slice(offset, offset + limit);
      });
    },

    async append(input) { return mutate((next) => appendRecord(next, input)); },

    async update(id, changes) {
      return mutate((next) => {
        assertNoRawPayload(changes);
        const record = findRecord(next, id);
        const immutable = ['id', 'state', 'attempts', 'first_attempt', 'created_at', 'review_count', 'next_review_at'];
        if (immutable.some((key) => Object.hasOwn(changes, key))) throw new QuizStoreValidationError('Lifecycle and attempt fields must be changed through their dedicated operations.');
        Object.assign(record, clone(changes), { updated_at: timestamp() });
        record.question_fingerprint = changes.question_fingerprint || questionFingerprint(record);
        assertRecord(record);
        return record;
      });
    },

    async transition(id, targetState) {
      return mutate((next) => {
        if (!QUESTION_STATE_SET.has(targetState)) throw new QuizStoreValidationError(`Unsupported question state: ${targetState}.`);
        const record = findRecord(next, id);
        if (record.state === targetState) return record;
        if (!TRANSITIONS[record.state].has(targetState)) throw new QuizStoreValidationError(`Invalid question transition: ${record.state} -> ${targetState}.`);
        record.state = targetState;
        record.updated_at = timestamp();
        if (targetState === 'scheduled_for_review' && !record.next_review_at) {
          const interval = reviewIntervalsMs[Math.min(record.review_count, reviewIntervalsMs.length - 1)];
          record.next_review_at = new Date(new Date(record.updated_at).getTime() + interval).toISOString();
        }
        return record;
      });
    },

    async recordAttempt(id, attempt) { return mutate((next) => recordAttempt(next, id, attempt)); },

    async updateAttemptFeedback(id, attemptId, feedback) { return mutate((next) => updateFeedback(next, id, attemptId, feedback)); },

    async scheduleReview(id, at) { return mutate((next) => scheduleReview(next, id, at)); },

    async importFeedbackRecords(rows) {
      if (!Array.isArray(rows) || rows.length > 1_000) throw new QuizStoreValidationError('History import requires at most 1,000 records.');
      return mutate((next) => {
        let imported = 0; let duplicates = 0;
        for (const { record, attempt } of rows) {
          const appended = appendRecord(next, record);
          if (appended.created) imported += 1; else duplicates += 1;
          const attempted = recordAttempt(next, appended.record.id, attempt);
          if (!appended.created && attempt.attempt_id && attempt.feedback && Object.keys(attempt.feedback).length) updateFeedback(next, appended.record.id, attempt.attempt_id, attempt.feedback);
          if (attempted.state === 'answered') scheduleReview(next, appended.record.id);
        }
        return { imported, duplicates };
      });
    },

    async exportPortable() {
      return read((current) => {
      const portable = clone(current);
      validateDocument(portable, maxRecords);
      assertNoRawPayload(portable, '$', 0, true);
      return portable;
      });
    },

    async importPortable(input, { replace = false } = {}) {
      const migrated = migrateQuizStoreDocument(input, { now: timestamp() });
      const legacyQuestions = (!Object.hasOwn(input, 'schema_version') || input.schema_version === 0) && !Object.hasOwn(input, 'records');
      assertNoRawPayload(input, '$', 0, legacyQuestions ? 'questions' : true);
      const incoming = validateDocument(migrated, maxRecords);
      const result = await mutate(async (next) => {
        const backupPath = `${filePath}.pre-import-${Date.now()}.bak`;
        await copyFile(filePath, backupPath);
        const candidates = replace ? [] : next.records;
        const knownIds = new Set(candidates.map(({ id }) => id));
        const knownFingerprints = new Set(candidates.map((record) => `${record.evidence_fingerprint}:${record.question_fingerprint}`));
        let imported = 0; let duplicates = 0;
        for (const record of incoming.records) {
          const key = `${record.evidence_fingerprint}:${record.question_fingerprint}`;
          if (knownIds.has(record.id) || knownFingerprints.has(key)) { duplicates += 1; continue; }
          if (candidates.length >= maxRecords) throw new QuizStoreLimitError(maxRecords);
          candidates.push(clone(record)); knownIds.add(record.id); knownFingerprints.add(key); imported += 1;
        }
        next.records = candidates;
        return { imported, duplicates, backupPath };
      });
      return result;
    },
  });
}

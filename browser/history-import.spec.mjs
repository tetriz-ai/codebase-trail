// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, importHistoryRecords } from '../server.mjs';
import { createQuizStore } from '../quiz-store.mjs';

const key = 'codebase-trail-feedback-v1';
const kept = { record_id: 'kept', saved_at: '2026-01-01T00:00:00.000Z', generation: { question: { question: 'Keep my explanation', explanation: 'Only browser copy' } } };
const incoming = { record_id: 'new', saved_at: '2026-02-01T00:00:00.000Z', generation: { question: { question: 'New valid question', explanation: 'Imported explanation' } } };
const test = base.extend({
  historyApp: async ({ page }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'history-import-browser-'));
    const filePath = join(directory, 'history.json');
    const store = createQuizStore({ filePath });
    await importHistoryRecords({ records: [kept] }, store);
    const server = createServer(createApp({ history_store: store, load_candidates: async () => ({ login: 'fixture', repository: 'fixture/repo', candidates: [] }) }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      await page.route(`${origin}/api/architecture/catalog`, (route) => route.fulfill({ json: { graph_build_id: 'fixture', complete: true, services: [], repositories: [], scopes: {}, diagnostics: [] } }));
      await page.goto(origin);
      await expect(page.locator('#provider-status')).not.toContainText('Checking');
      const before = JSON.stringify([kept], null, 2);
      await page.evaluate(({ key, before }) => localStorage.setItem(key, before), { key, before });
      await use({ store, filePath, origin, before });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
});
const upload = (page, records) => page.locator('#import-history').setInputFiles({ name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ records })) });
const browserBytes = (page) => page.evaluate((key) => localStorage.getItem(key), key);

test('rejected import preserves existing explanation and durable history', async ({ page, historyApp }) => {
  const durableBefore = await readFile(historyApp.filePath, 'utf8');
  const response = page.waitForResponse((response) => response.url().endsWith('/api/history/import'));
  await upload(page, [{ record_id: 'kept', saved_at: '2026-02-01T00:00:00.000Z' }]);
  expect((await response).status()).toBe(400);
  await expect(page.locator('#transfer-status')).toContainText('rejected');
  expect(await browserBytes(page)).toBe(historyApp.before);
  expect(await readFile(historyApp.filePath, 'utf8')).toBe(durableBefore);
});

test('network failure preserves browser explanations and existing durable records', async ({ page, historyApp }) => {
  const durableBefore = await readFile(historyApp.filePath, 'utf8');
  await page.route(`${historyApp.origin}/api/history/import`, (route) => route.abort('failed'));
  await upload(page, [{ ...kept, saved_at: incoming.saved_at, generation: incoming.generation }]);
  await expect(page.locator('#transfer-status')).toContainText('fetch');
  expect(await browserBytes(page)).toBe(historyApp.before);
  expect(await readFile(historyApp.filePath, 'utf8')).toBe(durableBefore);
});

test('accepted history import stores explanations after validation and preserves concurrent browser attempts', async ({ page, historyApp }) => {
  const concurrent = { ...kept, record_id: 'concurrent', generation: { question: { question: 'Answered while importing', explanation: 'Concurrent explanation' } } };
  await page.route(`${historyApp.origin}/api/history/import`, async (route) => {
    const response = await route.fetch();
    await page.evaluate(({ key, kept, concurrent }) => localStorage.setItem(key, JSON.stringify([kept, concurrent])), { key, kept, concurrent });
    await route.fulfill({ response });
  });
  await upload(page, [incoming, null]);
  await expect(page.locator('#transfer-status')).toContainText('Imported 1 item');
  await expect(page.locator('#transfer-status')).toContainText('(1 invalid skipped)');
  const records = JSON.parse(await browserBytes(page));
  expect(records.map(({ record_id }) => record_id).sort()).toEqual(['concurrent', 'kept', 'new']);
  expect(records.find(({ record_id }) => record_id === 'new').generation.question.explanation).toBe('Imported explanation');
  expect((await historyApp.store.list()).map(({ question }) => question).sort()).toEqual(['Keep my explanation', 'New valid question']);
});

test('accepted server import reports partial success when browser storage fails', async ({ page, historyApp }) => {
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Synthetic quota exhaustion', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, key);
  const response = page.waitForResponse((response) => response.url().endsWith('/api/history/import'));
  await upload(page, [incoming]);
  expect((await response).status()).toBe(200);
  await expect(page.locator('#transfer-status')).toHaveText('Answers were imported, but explanations could not be saved in this browser. Keep the import file and retry.');
  expect(await browserBytes(page)).toBe(historyApp.before);
  expect((await historyApp.store.list()).map(({ question }) => question).sort()).toEqual(['Keep my explanation', 'New valid question']);
});

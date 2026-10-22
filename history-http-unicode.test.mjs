// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createQuizStore } from './quiz-store.mjs';
import { createApp, uiApiToken } from './server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'history-http-unicode-'));
  const store = createQuizStore({ filePath: join(directory, 'history.json') });
  await store.append({ question: 'Existing?', evidence_pin: { revision: 'existing' } });
  const app = createApp({ history_store: store });
  let firstChunk;
  const server = createServer((incoming, response) => {
    app(incoming, response);
    incoming.once('data', bytes => firstChunk?.(bytes));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function post(bytes, split = bytes.length) {
    let observed;
    const received = new Promise(resolve => { firstChunk = chunk => { observed = chunk; resolve(); }; });
    const result = new Promise((resolve, reject) => {
      const outgoing = request(`${origin}/api/history/import`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-code-learning-token': uiApiToken } }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      });
      outgoing.on('error', reject);
      outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Test HTTP request timed out.')));
      outgoing.write(bytes.subarray(0, split));
      received.then(() => outgoing.end(bytes.subarray(split))).catch(reject);
    });
    const response = await result;
    assert.deepEqual(observed, bytes.subarray(0, split), 'The server must receive the requested first chunk separately.');
    return response;
  }
  return { store, post, disk: async () => Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => [name, await readFile(join(directory, name))]))) };
}
for (const mode of ['feedback-question', 'feedback-note', 'canonical-note']) for (const character of ['λ', '界', '😀']) {
  test(`HTTP import preserves ${mode} ${character} at every UTF-8 boundary`, async t => {
    const { store, post } = await fixture(t);
    for (let split = 1; split < Buffer.byteLength(character); split += 1) {
      const id = `${mode}-${character}-${split}`;
      const text = `Keep ${character} exactly.`;
      const payload = mode === 'canonical-note' ? { schema_version: 1, records: [{ id, question: `Question ${id}?`, question_fingerprint: id, evidence_fingerprint: id, evidence_pin: { revision: id }, state: 'published', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', attempts: [{ feedback: { subjective: text } }] }] } : { records: [{ record_id: id, generation: { question: { question: mode === 'feedback-question' ? text : `Question ${id}?`, evidence_pin: { revision: id } } }, feedback: { subjective: mode === 'feedback-note' ? text : 'ASCII note' } }] };
      const bytes = Buffer.from(JSON.stringify(payload));
      const at = bytes.indexOf(Buffer.from(text)) + Buffer.byteLength('Keep ');
      assert.ok(at >= Buffer.byteLength('Keep '));
      const response = await post(bytes, at + split);
      assert.equal(response.status, 200);
      assert.equal(response.body.imported, 1);
      const saved = (await store.list()).find(row => row.evidence_pin.revision === id);
      assert.equal(mode === 'feedback-question' ? saved.question : saved.attempts[0].feedback.subjective, text);
    }
  });
}
const invalidEncodings = [
  ['invalid leading byte', [255]], ['overlong', [192, 175]], ['isolated continuation', [128]],
  ['truncated two-byte sequence', [206]], ['truncated three-byte sequence', [226, 130]],
  ['truncated four-byte sequence', [240, 159, 152]],
];
for (const [name, bytes] of invalidEncodings) test(`HTTP import rejects ${name} without disk changes`, async t => {
  const { post, disk } = await fixture(t);
  const before = await disk();
  const prefix = Buffer.from('{"records":[{"record_id":"invalid","generation":{"question":{"question":"');
  const suffix = Buffer.from('","evidence_pin":{"revision":"invalid"}}}}]}');
  const response = await post(Buffer.concat([prefix, Buffer.from(bytes), suffix]));
  assert.equal(response.status, 400);
  assert.equal(response.body.error_code, 'history_import_invalid');
  assert.doesNotMatch(JSON.stringify(response.body), /history-http-unicode|history.json|invalid leading|decoder/i);
  assert.deepEqual(await disk(), before);
});

// The public handler accepts a synthetic IncomingMessage stream for byte ceilings.
// This avoids an oversized socket being torn down before its error response arrives.
async function handleBytes(chunks, token = uiApiToken, path = '/api/history/import') {
  const incoming = Readable.from(chunks);
  Object.assign(incoming, { method: 'POST', url: path, headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234', 'content-type': 'application/json', 'x-code-learning-token': token }, socket: { remoteAddress: '127.0.0.1' } });
  let calls = 0; let payload;
  const app = createApp({ analyze_architecture_repositories: value => { calls += 1; payload = value; return value; }, history_store: { importFeedbackRecords: async rows => { calls += 1; payload = rows; return { imported: 0, duplicates: 0 }; } } });
  const result = await new Promise(resolve => {
    const response = { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
    app(incoming, response);
  });
  return { ...result, calls, payload };
}
for (const character of ['x', 'λ']) test(`request raw-byte ceiling for ${character} is exactly 9 MiB`, async () => {
  const limit = 9 * 1024 * 1024;
  const prefix = '{"records":[],"padding":"'; const suffix = '"}';
  const room = limit - Buffer.byteLength(prefix + suffix);
  const bytes = Buffer.from(prefix + character.repeat(Math.floor(room / Buffer.byteLength(character))) + 'x'.repeat(room % Buffer.byteLength(character)) + suffix);
  assert.equal(bytes.length, limit);
  const accepted = await handleBytes([bytes.subarray(0, 31), bytes.subarray(31)]);
  assert.equal(accepted.status, 200); assert.equal(accepted.calls, 1); assert.deepEqual(accepted.payload, []);
  const rejected = await handleBytes([bytes, Buffer.from(' ')]);
  assert.equal(rejected.status, 400); assert.equal(rejected.calls, 0);
});
test('request decoding preserves empty body, JSON grammar and authorization neighbors', async () => {
  const empty = await handleBytes([], uiApiToken, '/api/architecture/analyze');
  assert.equal(empty.status, 200); assert.equal(empty.calls, 1); assert.deepEqual(empty.payload, {});
  for (const chunks of [[Buffer.from('{')], [Buffer.from('\uFEFF{"records":[]}')], [Buffer.from([0xe2, 0x82])]]) {
    const response = await handleBytes(chunks);
    assert.equal(response.status, 400); assert.equal(response.calls, 0);
  }
  assert.equal((await handleBytes([Buffer.from('{"records":[]}')])).status, 200);
  const unauthorized = await handleBytes([Buffer.from('{"records":[]}')], 'wrong-token');
  assert.equal(unauthorized.status, 403); assert.equal(unauthorized.calls, 0);
});

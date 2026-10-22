// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createQuizStore } from './quiz-store.mjs';
import { createApp, importHistoryRecords, uiApiToken } from './server.mjs';
const feedback = (id, notes = {}) => ({ record_id:id, source_scope:'lld', generation:{ question:{ question:`Who owns ${id}?`, answer_options:[{id:'A',text:'API'}], correct_option_id:'A', evidence_pin:{ revision:id } } }, learner_answer:{selected_option_id:'A',was_correct:true}, feedback:notes });
async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(),'history-integrity-'));
  const filePath = join(directory,'history.json');
  const store = createQuizStore({filePath,...options});
  try { await run({directory,filePath,store}); } finally { await rm(directory,{recursive:true,force:true}); }
}
test('unrecoverable durable history corruption is explicit and leaves both originals intact',()=>fixture(async({filePath,store})=>{
  await writeFile(filePath,'not-json');await writeFile(`${filePath}.bak`,'also-not-json');
  for(const action of [()=>store.list(),()=>store.append({question:'Repair?',evidence_pin:{revision:'x'}}),()=>store.exportPortable()]) await assert.rejects(action,{code:'history_store_corrupt'});
  assert.equal(await readFile(filePath,'utf8'),'not-json');assert.equal(await readFile(`${filePath}.bak`,'utf8'),'also-not-json');
}));
for(const [name,later,options] of [
  ['malformed later record',{},{}],
  ['capacity overflow on a later record',feedback('two'),{maxRecords:1}],
  ['invalid feedback on a later record',feedback('two',{unexpected:'bad'}),{}],
]) test(`feedback import rolls back ${name}`,()=>fixture(async({filePath,store})=>{
  await store.initialize();const before=await readFile(filePath,'utf8');
  await assert.rejects(importHistoryRecords({records:[feedback('one'),later]},store));
  assert.deepEqual(await store.list(),[]);assert.equal(await readFile(filePath,'utf8'),before);
},options));
test('a later invalid row rolls back feedback changes to an existing attempt',()=>fixture(async({store,filePath})=>{
  await importHistoryRecords({records:[feedback('existing',{subjective:'Original note'})]},store);
  const before=await readFile(filePath,'utf8');
  await assert.rejects(importHistoryRecords({records:[feedback('existing',{subjective:'Changed note'}),feedback('invalid',{unexpected:'bad'})]},store));
  assert.equal(await readFile(filePath,'utf8'),before);
  assert.equal((await store.list())[0].first_attempt.feedback.subjective,'Original note');
}));
test('duplicate feedback update and concurrent append preserve all attempts and records',()=>fixture(async({store})=>{
  assert.deepEqual(await importHistoryRecords({records:[feedback('one')]},store),{imported:1,duplicates:0});
  const results=await Promise.all([
    importHistoryRecords({records:[feedback('one',{subjective:'Revised note'}),feedback('two')]},store),
    store.append({question:'Concurrent third?',evidence_pin:{revision:'third'}}),
  ]);
  assert.deepEqual(results[0],{imported:1,duplicates:1});
  const records=await store.list();assert.equal(records.length,3);
  const first=records.find(r=>r.question==='Who owns one?');assert.equal(first.attempts.length,1);assert.equal(first.review_count,1);assert.equal(first.state,'scheduled_for_review');assert.equal(first.first_attempt.feedback.subjective,'Revised note');
}));
test('real HTTP history routes report corruption and reject entire malformed import batches',()=>fixture(async({filePath,store})=>{
  const server=createServer(createApp({history_store:store}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const headers={'x-code-learning-token':uiApiToken,origin:base,'content-type':'application/json'};
  const priorError=console.error;console.error=()=>{};
  try {
    await store.initialize();const before=await readFile(filePath,'utf8');
    const rejected=await fetch(`${base}/api/history/import`,{method:'POST',headers,body:JSON.stringify({records:[feedback('http'),{}]})});assert.equal(rejected.status,400);assert.equal(await readFile(filePath,'utf8'),before);
    await writeFile(filePath,'not-json');await writeFile(`${filePath}.bak`,'also-not-json');
    const corrupt=createQuizStore({filePath});
    const failingServer=createServer(createApp({history_store:corrupt}));await new Promise(r=>failingServer.listen(0,'127.0.0.1',r));
    try {const url=`http://127.0.0.1:${failingServer.address().port}`;for(const path of ['/api/history','/api/history/export']){const response=await fetch(url+path,{headers:{'x-code-learning-token':uiApiToken}});assert.equal(response.status,503);const body=await response.json();assert.equal(body.error_code,'history_store_corrupt');assert.match(body.error,/repair/i);assert.doesNotMatch(JSON.stringify(body),/history-integrity-|history\.json|not-json/);}}
    finally {await new Promise(r=>failingServer.close(r));}
  } finally {console.error=priorError;await new Promise(r=>server.close(r));}
}));

for (const count of [250, 251, 1000]) test(`portable history round-trips ${count} bounded records`, () => fixture(async ({ store }) => {
  await store.append({ question: 'Seed question?', evidence_pin: { revision: 'seed' } });
  const document = await store.exportPortable();
  const template = document.records[0];
  document.records = Array.from({ length: count }, (_, index) => ({ ...structuredClone(template), id: `record-${index}`, question_fingerprint: `question-${index}`, evidence_fingerprint: `evidence-${index}` }));
  assert.equal((await store.importPortable(document, { replace: true })).imported, count);
  assert.equal((await store.exportPortable()).records.length, count);
  assert.equal((await store.list({ limit: 1000 })).length, count);
  if (count === 251) {
    const server = createServer(createApp({ history_store: store }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/history/export`, { headers: { 'x-code-learning-token': uiApiToken } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).records.length, count);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
}));
test('portable document allowance retains configured record and nested array limits', () => fixture(async ({ store, filePath }) => {
  await store.append({ question: 'Seed?', evidence_pin: { revision: 'seed' } });
  const document = await store.exportPortable();
  const before = await readFile(filePath, 'utf8');
  const oversized = structuredClone(document);
  oversized.records.push({ ...structuredClone(document.records[0]), id: 'second', question_fingerprint: 'second' });
  await assert.rejects(store.importPortable(oversized), { name: 'QuizStoreLimitError' });
  const nested = structuredClone(document);
  nested.records[0].choices = Array(251).fill('Choice');
  await assert.rejects(store.importPortable(nested), /array exceeds 250 entries/);
  assert.equal(await readFile(filePath, 'utf8'), before);
}, { maxRecords: 1 }));

test('history pagination rejects malformed values and preserves valid boundaries', () => fixture(async ({ store }) => {
  await store.append({ question: 'Pagination?', evidence_pin: { revision: 'page' } });
  for (const key of ['limit', 'offset']) for (const value of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(store.list({ [key]: value }), /nonnegative safe integer/);
  await assert.rejects(store.list({ state: 'unknown' }), /Unsupported question state/);
  assert.equal((await store.list({ limit: 0 })).length, 0);
  assert.equal((await store.list({ limit: 1, offset: 0 })).length, 1);
  assert.equal((await store.list({ limit: 1, offset: 1 })).length, 0);
}));
test('HTTP history pagination rejects malformed values', () => fixture(async ({ store }) => {
  await store.append({ question: 'Pagination?', evidence_pin: { revision: 'page' } });
  const server = createServer(createApp({ history_store: store }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = path => fetch(base + path, { headers: { 'x-code-learning-token': uiApiToken } });
  try {
    for (const key of ['limit', 'offset']) for (const value of ['oops', 'NaN', 'Infinity', '-Infinity', '-1', '0.5', '9007199254740992']) {
      const response = await get(`/api/history?${key}=${value}`);
      assert.equal(response.status, 400, `${key}=${value}`);
      assert.equal((await response.json()).error_code, 'history_query_invalid');
    }
    const invalidState = await get('/api/history?state=unknown');
    assert.equal(invalidState.status, 400);
    assert.equal((await invalidState.json()).error_code, 'history_query_invalid');
    for (const query of ['', '?limit=&offset=', '?limit=1', '?limit=1e0', '?limit=250', '?limit=251']) {
      const response = await get('/api/history' + query); assert.equal(response.status, 200);
      assert.equal((await response.json()).records.length, 1);
    }
    assert.equal((await (await get('/api/history?limit=0')).json()).records.length, 0);
    assert.equal((await (await get('/api/history?offset=1')).json()).records.length, 0);
    for (const path of ['/api/history/typo', '/api/history/export/typo']) assert.equal((await get(path)).status, 404);
    assert.equal((await get('/api/history/export?download=1')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));
test('HTTP history limit caps valid integers at250', () => fixture(async ({ store }) => {
  await store.append({ question: 'Cap?', evidence_pin: { revision: 'cap' } });
  const document = await store.exportPortable();
  document.records = Array.from({ length: 251 }, (_, index) => ({ ...structuredClone(document.records[0]), id: `cap-${index}`, question_fingerprint: `cap-${index}` }));
  await store.importPortable(document, { replace: true });
  const server = createServer(createApp({ history_store: store }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { for (const limit of [250, 251, Number.MAX_SAFE_INTEGER]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/history?limit=${limit}`, { headers: { 'x-code-learning-token': uiApiToken } });
    assert.equal(response.status, 200); assert.equal((await response.json()).records.length, 250);
  } } finally { await new Promise(resolve => server.close(resolve)); }
}));

test('unknown history paths return404 while export query strings remain valid', () => fixture(async ({ store }) => {
  await store.initialize();
  const server = createServer(createApp({ history_store: store }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { for (const path of ['/api/history/typo', '/api/history/export/typo']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: { 'x-code-learning-token': uiApiToken } });
    assert.equal(response.status, 404);
  } } finally { await new Promise(resolve => server.close(resolve)); }
}));

function nestedEvidence(depth, leaf = 'Bounded evidence') {
  let value = leaf;
  for (let level = 1; level < depth; level += 1) value = { nested: value };
  return value;
}
for (const depth of [9, 10, 11, 12]) test(`portable envelope preserves record depth${depth}`, () => fixture(async ({ store, directory }) => {
  await store.append({ question: `Depth ${depth}?`, evidence_pin: nestedEvidence(depth) });
  const document = await store.exportPortable();
  const imported = createQuizStore({ filePath: join(directory, 'imported.json') });
  assert.equal((await imported.importPortable(document)).imported, 1);
  assert.deepEqual((await imported.exportPortable()).records, document.records);
}));
test('portable record depth and strings retain exact existing bounds', () => fixture(async ({ store, filePath }) => {
  await store.initialize(); const original = await readFile(filePath, 'utf8');
  await assert.rejects(store.append({ question: 'Too deep?', evidence_pin: nestedEvidence(13) }), /too deeply nested/);
  await assert.rejects(store.append({ question: 'Too long?', evidence_pin: { bounded: 'x'.repeat(8001) } }), /8,000 characters/);
  await assert.rejects(store.append({ question: 'Raw?', evidence_pin: { nested: { raw_source: 'private fixture' } } }), /not portable/);
  assert.equal(await readFile(filePath, 'utf8'), original);
  await store.append({ question: 'At string boundary?', evidence_pin: { bounded: 'x'.repeat(8000) } });
  const document = await store.exportPortable();
  const before = await readFile(filePath, 'utf8');
  for (const [evidence, pattern] of [[nestedEvidence(13), /too deeply nested/], [{ bounded: 'x'.repeat(8001) }, /8,000 characters/], [{ nested: { raw_source: 'private fixture' } }, /not portable/]]) {
    const invalid = structuredClone(document); invalid.records[0].evidence_pin = evidence;
    await assert.rejects(store.importPortable(invalid), pattern);
    assert.equal(await readFile(filePath, 'utf8'), before);
  }
}));
test('portable record byte bound accepts128KiB and rejects one extra byte', () => fixture(async ({ store, filePath }) => {
  await store.append({ question: 'Record byte budget?', evidence_pin: { revision: 'bytes' } });
  const document = await store.exportPortable(); const record = document.records[0];
  record.evidence_pin = { chunks: Array(16).fill('x'.repeat(8000)), padding: '' };
  const padding = 128 * 1024 - Buffer.byteLength(JSON.stringify(record));
  assert.ok(padding >= 0 && padding <= 8000);
  record.evidence_pin.padding = 'x'.repeat(padding);
  assert.equal(Buffer.byteLength(JSON.stringify(record)), 128 * 1024);
  await store.importPortable(document, { replace: true });
  const before = await readFile(filePath, 'utf8');
  record.evidence_pin.padding += 'x';
  await assert.rejects(store.importPortable(document, { replace: true }), /128 KiB portable limit/);
  assert.equal(await readFile(filePath, 'utf8'), before);
}));

test('history HTTP omitted and blank limits return100 of101 records', () => fixture(async ({ store }) => {
  await store.append({ question: 'Default limit?', evidence_pin: { revision: 'default' } });
  const document = await store.exportPortable();
  document.records = Array.from({ length: 101 }, (_, index) => ({ ...structuredClone(document.records[0]), id: `default-${index}`, question_fingerprint: `default-${index}` }));
  await store.importPortable(document, { replace: true });
  const server = createServer(createApp({ history_store: store }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { for (const query of ['', '?limit=&offset=']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/history${query}`, { headers: { 'x-code-learning-token': uiApiToken } });
    assert.equal(response.status, 200); assert.equal((await response.json()).records.length, 100);
  } } finally { await new Promise(resolve => server.close(resolve)); }
}));
test('recovery preserves valid backup bytes for a second corruption', () => fixture(async ({ store, filePath }) => {
  await store.append({ question: 'Recover twice?', evidence_pin: { revision: 'recovery' } });
  await writeFile(`${filePath}.bak`, JSON.stringify(await store.exportPortable()));
  const backup = await readFile(`${filePath}.bak`, 'utf8');
  for (const corrupt of ['First corruption', 'Second corruption']) {
    await writeFile(filePath, corrupt);
    const recovered = createQuizStore({ filePath });
    assert.equal((await recovered.list()).length, 1);
    assert.equal(await readFile(`${filePath}.bak`, 'utf8'), backup);
  }
}));
test('concurrent feedback imports serialize without losing either batch', () => fixture(async ({ store }) => {
  const outcomes = await Promise.all([
    importHistoryRecords({ records: [feedback('batch-a'), feedback('batch-b')] }, store),
    importHistoryRecords({ records: [feedback('batch-c'), feedback('batch-d')] }, store),
  ]);
  assert.deepEqual(outcomes, [{ imported: 2, duplicates: 0 }, { imported: 2, duplicates: 0 }]);
  assert.equal((await store.list()).length, 4);
}));

const malformedImportTags = [null, '0', '1', false, true, 0.5, -0.5, -1, 'unknown', 2];
test('history import rejects malformed schema tags before dispatch without touching saved data', () => fixture(async ({ directory, filePath, store }) => {
  await importHistoryRecords({ records: [feedback('existing')] }, store);
  const primary = await readFile(filePath); const backup = await readFile(`${filePath}.bak`);
  for (const schema_version of malformedImportTags) {
    await assert.rejects(importHistoryRecords({ schema_version, records: [] }, store), /schema|supported/);
    assert.deepEqual(await readFile(filePath), primary); assert.deepEqual(await readFile(`${filePath}.bak`), backup);
  }
  for (const payload of [{ records: [feedback('untagged')] }, { schema_version: 'codebase-trail-history-v1', records: [feedback('fallback')] }]) {
    assert.equal((await importHistoryRecords(payload, store)).imported, 1);
  }
  const document = await store.exportPortable();
  for (const schema_version of [0, 1]) {
    const target = createQuizStore({ filePath: join(directory, `schema-${schema_version}.json`) });
    assert.equal((await importHistoryRecords({ ...document, schema_version }, target)).imported, 3);
  }
}));
test('HTTP history import rejects malformed schema tags and preserves valid format neighbors', () => fixture(async ({ filePath, store }) => {
  await importHistoryRecords({ records: [feedback('existing')] }, store);
  const server = createServer(createApp({ history_store: store }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const post = payload => fetch(`http://127.0.0.1:${server.address().port}/api/history/import`, { method: 'POST', headers: { origin: `http://127.0.0.1:${server.address().port}`, 'content-type': 'application/json', 'x-code-learning-token': uiApiToken }, body: JSON.stringify(payload) });
  try {
    const primary = await readFile(filePath); const backup = await readFile(`${filePath}.bak`);
    for (const schema_version of malformedImportTags) {
      const response = await post({ schema_version, records: [] });
      assert.equal(response.status, 400, JSON.stringify(schema_version));
      assert.deepEqual(await readFile(filePath), primary); assert.deepEqual(await readFile(`${filePath}.bak`), backup);
    }
    for (const payload of [{ records: [feedback('http-untagged')] }, { schema_version: 'codebase-trail-history-v1', records: [feedback('http-fallback')] }, { schema_version: 0, records: [] }, { schema_version: 1, records: [] }]) {
      const response = await post(payload); assert.equal(response.status, 200); assert.ok(Object.hasOwn(await response.json(), 'imported'));
    }
    assert.equal((await store.list()).length, 3);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import './test-safety.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const review = { decision: 'pass', critique: 'Fixed synthetic example.', answer_key_consistent: true, exactly_one_defensible: true, mental_model_transferable: true, avoids_identifier_trivia: true, scenario_distinct: true, evidence_grounded: true, learner_prose_concise: true };

export async function withExampleSession(run) {
  const temporary = await mkdtemp(join(tmpdir(), 'codebase-trail-example-'));
  const checkout = join(temporary, 'repository');
  await mkdir(join(checkout, 'src'), { recursive: true });
  await writeFile(join(checkout, 'package.json'), '{"name":"example-repository"}\n');
  await writeFile(join(checkout, 'src', 'api.js'), 'import worker from "./worker.js"; export default worker;\n');
  await writeFile(join(checkout, 'src', 'worker.js'), 'export default function worker() { return "ready"; }\n');
  for (const args of [['init', '-b', 'main'], ['add', 'package.json', 'src'], ['-c', 'user.name=Example Author', '-c', 'user.email=example@example.com', 'commit', '-m', 'Synthetic fixture']]) execFileSync('git', ['-C', checkout, ...args], { stdio: 'ignore' });
  const model = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/models') return response.end(JSON.stringify({ data: [{ id: 'fixed-example' }] }));
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const name = body.response_format?.json_schema?.name || '';
    let value = review;
    if (!name.includes('adversarial_review')) {
      const text = body.messages.find((message) => message.role === 'user').content;
      const input = JSON.parse(text.match(/<UNTRUSTED_INPUT>\n([\s\S]+)\n<\/UNTRUSTED_INPUT>/)[1]).input;
      value = { question_type: 'component_role', mental_model_kind: 'responsibility', mental_model: 'Imports identify a dependency boundary.', context: 'The API imports a worker component.', question: 'Which component can be affected by a change to the worker?', answer_a: 'The API that imports the worker.', answer_b: 'Every unrelated component.', answer_c: 'No component can be affected.', correct_option_id: 'A', explanation: 'The API imports the worker. That import connects the caller to its dependency.', supporting_claim_ids: input.claims[0].claim_id };
    }
    response.end(JSON.stringify({ model: 'fixed-example', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
  });
  let launcher;
  try {
    model.listen(0, '127.0.0.1'); await once(model, 'listening');
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
    launcher = spawn(process.execPath, [fileURLToPath(new URL('../launcher.mjs', import.meta.url))], { cwd: checkout, env: { ...process.env, CODEBASE_TRAIL_HOME: join(temporary, 'settings'), CODEBASE_TRAIL_NO_BROWSER: '1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = ''; launcher.stderr.on('data', (chunk) => { diagnostics += chunk; });
    const base = `http://127.0.0.1:${port}`;
    let html;
    for (let tries = 0; tries < 100; tries++) {
      if (launcher.exitCode !== null) throw new Error(diagnostics || 'Example launcher exited.');
      try { const response = await fetch(`${base}/settings`); if (response.ok) { html = await response.text(); break; } } catch { /* Wait for loopback listener. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(html, 'Launcher must open setup.');
    const setupToken = html.match(/const token='([^']+)'/)[1];
    const config = { version: 1, source: { provider: 'local-git', checkout }, model: { provider: 'openai-compatible', endpoint: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixed-example', authMode: 'none', apiKeyEnv: null, sourceEgress: 'local' } };
    const saved = await fetch(`${base}/api/settings`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-code-learning-token': setupToken }, body: JSON.stringify({ config }) });
    assert.equal(saved.status, 200, await saved.text());
    const app = await (await fetch(base)).text();
    const token = app.match(/const apiToken = '([^']+)'/)?.[1] || app.match(/const token='([^']+)'/)?.[1];
    assert.ok(token, 'Learning UI must supply its capability token.');
    const call = async (path, body) => {
      const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-code-learning-token': token, ...(body ? { origin: base, 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    await run(call, { base });
  } finally {
    if (launcher && launcher.exitCode === null) { launcher.kill(); await once(launcher, 'exit'); }
    await new Promise((resolve) => model.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
}

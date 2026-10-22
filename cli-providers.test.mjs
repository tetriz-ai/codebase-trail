// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFile, access } from 'node:fs/promises';
import { CliModelProvider } from './providers/model/cli.mjs';
import { loadConfig, publicConfig } from './config.mjs';
import { dependencyChecks } from './settings-store.mjs';
import { createConfiguredModelProvider } from './server.mjs';

const request = { messages: [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: 'Synthetic evidence only.' }], schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, maxTokens: 4_096 };

test('CLI completions use declared capabilities without an extra process per model call', async () => {
  for (const id of ['claude-cli', 'codex-cli']) {
    const fake = fakeProcess(async ({ child, args }) => {
      if (args[0] !== '--version') {
        if (id === 'claude-cli') child.stdout.write(JSON.stringify({ subtype: 'success', structured_output: { answer: 'A' } }));
        else await writeFile(args[args.indexOf('--output-last-message') + 1], '{"answer":"A"}');
      }
      child.emit('close', 0);
    });
    const provider = new CliModelProvider({ provider: id, spawnProcess: fake.spawnProcess });
    for (let attempt = 0; attempt < 2; attempt++) {
      const capabilities = await provider.capabilitiesOrUnknown();
      assert.equal(capabilities.jsonSchema, true);
      assert.equal(capabilities.modelAdvertised, false);
      assert.equal(capabilities.contextWindowTokens, null);
      assert.deepEqual((await provider.completeJson(request)).value, { answer: 'A' });
    }
    assert.equal(fake.calls.length, 2, 'generation and review should each start only the completion process');
    await provider.probeCapabilities();
    assert.equal(fake.calls.at(-1).args[0], '--version', 'explicit installation checks still probe the executable');
  }
});

test('declared CLI capabilities preserve cancellation and completion detects missing binaries', async () => {
  let starts = 0;
  const provider = new CliModelProvider({ provider: 'claude-cli', spawnProcess: () => { starts++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled fixture'));
  await assert.rejects(provider.capabilitiesOrUnknown({ signal: cancelled.signal }), /cancelled fixture/);
  assert.equal(starts, 0);
  assert.equal((await provider.capabilitiesOrUnknown()).jsonSchema, true);
  await assert.rejects(provider.completeJson(request), error => error.code === 'model_cli_missing' && error.retryable === false);
});

function fakeProcess(onInput) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { child.emit('close', 1); };
    calls.push({ command, args, options });
    child.stdin.on('finish', async () => {
      try { await onInput({ child, command, args, options, input: child.stdin.read()?.toString() || '' }); }
      catch { child.emit('close', 1); }
    });
    return child;
  };
  return { calls, spawnProcess };
}

test('CLI settings select signed-in providers without API credentials or fake local-egress claims', async () => {
  for (const provider of ['claude-cli', 'codex-cli']) {
    const config = await loadConfig({ overrides: { model: { provider } }, env: {} });
    assert.equal(config.model.authMode, 'none');
    assert.equal(config.model.apiKeyEnv, null);
    assert.equal(config.model.model, 'default');
    assert.equal(config.model.timeoutMs, 120_000);
    assert.equal(config.model.reviewTimeoutMs, 120_000);
    assert.equal(config.model.sourceEgress, 'remote');
    assert.equal(publicConfig(config, { env: {} }).model.credential.required, false);
    await assert.rejects(loadConfig({ overrides: { model: { provider, sourceEgress: 'local' } }, env: {} }), /sourceEgress=local/);
  }
  const distinct = await loadConfig({ overrides: { model: { reviewProvider: 'codex-cli' } }, env: {} });
  assert.equal(distinct.model.reviewEndpoint, 'https://codex.cli.invalid');
  assert.equal(distinct.model.reviewAuthMode, 'none');
  assert.equal(distinct.model.reviewSourceEgress, 'remote');
});

test('generation and reviewer can select different CLI models', async () => {
  const config = await loadConfig({ overrides: { model: {
    provider: 'claude-cli', model: 'claude-sonnet-4-5',
    reviewProvider: 'codex-cli', reviewModel: 'gpt-6-luna',
  } }, env: {} });
  const generation = createConfiguredModelProvider(config.model);
  const review = createConfiguredModelProvider(config.model, 'review');
  assert.equal(generation.id, 'claude-cli');
  assert.equal(generation.model, 'claude-sonnet-4-5');
  assert.equal(review.id, 'codex-cli');
  assert.equal(review.model, 'gpt-6-luna');
});

test('Claude print mode receives bounded evidence on stdin and returns structured output without tools', async () => {
  const fake = fakeProcess(async ({ child, args, options, input }) => {
    if (args[0] === '--version') { child.stdout.write('2.1.285\n'); child.emit('close', 0); return; }
    assert.equal(args.includes('--restricted'), true);
    assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
    assert.equal(args.includes('--no-session-persistence'), true);
    assert.equal(args.includes('--json-schema'), true);
    assert.match(input, /Synthetic evidence only/);
    assert.equal(options.env.UNRELATED_SECRET, undefined);
    child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', structured_output: { answer: 'A' }, usage: { input_tokens: 12, output_tokens: 4 } }));
    child.emit('close', 0);
  });
  const provider = new CliModelProvider({ provider: 'claude-cli', model: 'default', env: { PATH: process.env.PATH, UNRELATED_SECRET: 'hidden' }, spawnProcess: fake.spawnProcess });
  const result = await provider.completeJson(request);
  assert.deepEqual(result.value, { answer: 'A' });
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(fake.calls[0].command, 'claude');
  await assert.rejects(access(fake.calls[0].options.cwd));
});

test('Codex exec uses a schema file, read-only sandbox, and final-message file in a temporary workspace', async () => {
  const fake = fakeProcess(async ({ child, args, input }) => {
    if (args[0] === '--version') { child.emit('close', 0); return; }
    assert.equal(args[0], 'exec');
    assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
    assert.equal(args.includes('--ignore-user-config'), true);
    assert.equal(args.at(-1), '-');
    assert.match(input, /Synthetic evidence only/);
    const schema = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(args[args.indexOf('--output-schema') + 1], 'utf8')));
    assert.deepEqual(schema, request.schema);
    await writeFile(args[args.indexOf('--output-last-message') + 1], '{"answer":"B"}');
    child.emit('close', 0);
  });
  const provider = new CliModelProvider({ provider: 'codex-cli', model: 'default', spawnProcess: fake.spawnProcess });
  const result = await provider.completeJson(request);
  assert.deepEqual(result.value, { answer: 'B' });
  assert.equal(fake.calls[0].command, 'codex');
  await assert.rejects(access(fake.calls[0].options.cwd));
});

test('explicit CLI model selection is passed to both command families', async () => {
  for (const [provider, command, model] of [['claude-cli', 'claude', 'claude-sonnet-4-5'], ['codex-cli', 'codex', 'gpt-6-luna']]) {
    const fake = fakeProcess(async ({ child, args }) => {
      assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', model]);
      if (provider === 'claude-cli') child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', structured_output: { answer: 'selected' } }));
      else await writeFile(args[args.indexOf('--output-last-message') + 1], '{"answer":"selected"}');
      child.emit('close', 0);
    });
    const result = await new CliModelProvider({ provider, model, spawnProcess: fake.spawnProcess }).completeJson(request);
    assert.equal(result.value.answer, 'selected');
    assert.equal(fake.calls[0].command, command);
  }
});

test('CLI reasoning controls reach the selected model process', async () => {
  for (const [provider, effort] of [['claude-cli', 'none'], ['claude-cli', 'low'], ['codex-cli', 'low']]) {
    const fake = fakeProcess(async ({ child, args, options }) => {
      if (provider === 'claude-cli') {
        assert.equal(options.env.MAX_THINKING_TOKENS, effort === 'none' ? '0' : undefined);
        assert.equal(args.includes('--effort'), effort === 'low');
        child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', structured_output: { answer: 'ok' } }));
      } else {
        assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'model_reasoning_effort="low"']);
        await writeFile(args[args.indexOf('--output-last-message') + 1], '{"answer":"ok"}');
      }
      child.emit('close', 0);
    });
    const result = await new CliModelProvider({ provider, reasoningEffort: effort, spawnProcess: fake.spawnProcess }).completeJson(request);
    assert.equal(result.reasoningRequestMode, `cli_${effort}`);
  }
});

test('Claude rejects an unrecognized model with actionable non-retryable error', async () => {
  const fake = fakeProcess(async ({ child }) => {
    child.stderr.write('[claude-code:unrecognized_model] {"model":"haiku-4-5"}');
    child.emit('close', 1);
  });
  const provider = new CliModelProvider({ provider: 'claude-cli', model: 'haiku-4-5', spawnProcess: fake.spawnProcess });
  await assert.rejects(provider.completeJson(request), (error) => error.code === 'model_cli_invalid_model' && error.retryable === false && /haiku-4-5/.test(error.message));
});

test('CLI dependency checks guide missing install and sign-in separately', async () => {
  const checks = await dependencyChecks({ model: { provider: 'claude-cli', reviewProvider: 'codex-cli' } }, { checkParsers: async () => {}, runCommand: async (command, args) => {
    if (command === 'claude') throw new Error('missing');
    if (command === 'codex' && args[0] === 'login') throw new Error('not signed in');
    return { stdout: `${command} 1.0\n` };
  } });
  assert.equal(checks.find((item) => item.name === 'Claude CLI').ok, false);
  assert.match(checks.find((item) => item.name === 'Claude CLI').detail, /Install Claude/);
  assert.equal(checks.find((item) => item.name === 'Codex CLI').ok, true);
  assert.equal(checks.find((item) => item.name === 'Codex sign-in').ok, false);
  assert.match(checks.find((item) => item.name === 'Codex sign-in').detail, /codex login/);
});

test('unselected missing CLI is detected without blocking setup', async () => {
  const checks = await dependencyChecks({ model: { provider: 'openai-compatible', reviewProvider: 'openai-compatible' } }, { checkParsers: async () => {}, runCommand: async (command) => {
    if (command === 'claude' || command === 'codex') throw new Error('missing');
    return { stdout: `${command} 1.0\n` };
  } });
  for (const name of ['Claude CLI', 'Codex CLI']) {
    const check = checks.find((item) => item.name === name);
    assert.equal(check.ok, false);
    assert.equal(check.required, false);
  }
});

test('CLI failure never returns process output containing prompt text', async () => {
  const fake = fakeProcess(async ({ child, input }) => { child.stderr.write(`failed: ${input}`); child.emit('close', 1); });
  const provider = new CliModelProvider({ provider: 'claude-cli', spawnProcess: fake.spawnProcess });
  await assert.rejects(provider.completeJson(request), (error) => error.code === 'model_cli_failed' && !error.message.includes('Synthetic evidence'));
});

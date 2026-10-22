// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import crossSpawn from 'cross-spawn';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_API_VERSION } from '../contracts.mjs';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const COMMANDS = Object.freeze({ 'claude-cli': 'claude', 'codex-cli': 'codex' });

function failure(code, message, retryable = false) {
  const error = new Error(message); error.code = code; error.retryable = retryable; return error;
}
function childEnvironment(env, command, reasoningEffort) {
  // CLI authentication can come from the user's login or these provider keys.
  // Never forward unrelated application credentials or observability settings.
  const names = ['PATH', 'HOME', 'USER', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
  if (command === 'codex') names.push('CODEX_HOME', 'OPENAI_API_KEY');
  else names.push('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN');
  const childEnv = Object.fromEntries(names.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name]]));
  if (command === 'claude' && reasoningEffort === 'none') childEnv.MAX_THINKING_TOKENS = '0';
  return childEnv;
}
function runProcess(command, args, { cwd, input = '', timeoutMs, signal, env, spawnProcess, model, reasoningEffort }) {
  return new Promise((resolve, reject) => {
    const timed = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timed]) : timed;
    let child;
    try { child = spawnProcess(command, args, { cwd, env: childEnvironment(env, command, reasoningEffort), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: combined }); }
    catch (error) { reject(error?.code === 'ENOENT' ? failure('model_cli_missing', `Install ${command} and add it to PATH.`) : failure('model_cli_failed', `${command} could not start.`)); return; }
    let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; error ? reject(error) : resolve(value); };
    child.on('error', (error) => finish(error?.code === 'ENOENT' ? failure('model_cli_missing', `Install ${command} and add it to PATH.`) : combined.aborted ? signal?.aborted ? failure('model_transport_timeout_or_cancelled', 'Model request was cancelled.') : failure('model_provider_timeout', `${command} exceeded its ${Math.ceil(timeoutMs / 1000)} second time limit.`, true) : failure('model_cli_failed', `${command} could not start.`)));
    for (const [stream, kind] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', (chunk) => {
      if (kind === 'stdout') { stdoutBytes += chunk.length; if (stdoutBytes <= MAX_CAPTURE_BYTES) stdout += chunk; }
      else { stderrBytes += chunk.length; if (stderrBytes <= MAX_CAPTURE_BYTES) stderr += chunk; }
      if (stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES) { child.kill(); finish(failure('model_provider_response_too_large', `${command} produced too much output.`)); }
    });
    child.on('close', (code) => {
      if (combined.aborted) return finish(signal?.aborted ? failure('model_transport_timeout_or_cancelled', 'Model request was cancelled.') : failure('model_provider_timeout', `${command} exceeded its ${Math.ceil(timeoutMs / 1000)} second time limit.`, true));
      if (code !== 0) {
        const output = `${stderr}\n${stdout}`;
        if (/(?:unrecognized_model|issue with the selected model|model (?:does not exist|not found|is not available))/i.test(output)) return finish(failure('model_cli_invalid_model', `${command} does not recognize model ${model}. Choose a supported model in Settings.`, false));
        return finish(failure(/(?:not logged in|login required|authentication failed|unauthorized)/i.test(output) ? 'model_cli_auth_required' : 'model_cli_failed', `${command} exited without a usable answer. Check its sign-in with ${command === 'claude' ? 'claude auth status' : 'codex login status'}.`));
      }
      finish(null, { stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export class CliModelProvider {
  apiVersion = PROVIDER_API_VERSION;
  kind = 'cli';
  constructor({ provider, model = 'default', timeoutMs = 60_000, reasoningEffort = null, env = process.env, spawnProcess = crossSpawn } = {}) {
    if (!COMMANDS[provider]) throw new TypeError('CLI provider must be claude-cli or codex-cli');
    if (typeof model !== 'string' || !model || model.length > 200 || !/^[A-Za-z0-9_.:/-]+$/.test(model)) throw new TypeError('CLI model must be a bounded model ID or default');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError('Invalid CLI timeout');
    if (reasoningEffort !== null && !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) throw new TypeError('Invalid CLI reasoning effort');
    this.id = provider; this.model = model; this.timeoutMs = timeoutMs; this.reasoningEffort = reasoningEffort; this.command = COMMANDS[provider];
    Object.defineProperties(this, { env: { value: env }, spawnProcess: { value: spawnProcess } });
  }
  async probeCapabilities({ signal, timeoutMs = 3_000 } = {}) {
    await runProcess(this.command, ['--version'], { cwd: tmpdir(), timeoutMs, signal, env: this.env, spawnProcess: this.spawnProcess });
    return this.capabilitiesOrUnknown({ signal });
  }
  async capabilitiesOrUnknown({ signal } = {}) {
    signal?.throwIfAborted();
    // These capabilities come from our fixed CLI flags, not executable discovery.
    // Completion reports missing binaries/authentication; avoid an extra CLI startup per request.
    return { model: this.model, modelAdvertised: false, jsonSchema: true, cancellation: true, contextWindowTokens: null, maxCompletionTokens: null, supportedParameters: [] };
  }
  async completeJson({ messages, schema, schemaName = 'quiz_response', temperature = 0, maxTokens, timeoutMs = this.timeoutMs, signal, requestExtensions = {} } = {}) {
    if (!Array.isArray(messages) || !messages.length || !schema || typeof schema !== 'object' || Array.isArray(schema)) throw new TypeError('Messages and JSON schema are required');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(schemaName) || !Number.isFinite(temperature) || temperature < 0 || temperature > 2 || maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) throw new TypeError('Invalid CLI completion options');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || Object.keys(requestExtensions).length) throw new TypeError('Invalid CLI completion options');
    const prompt = messages.map((message) => `${message.role === 'system' ? 'System instructions' : 'User input'}:\n${String(message.content || '')}`).join('\n\n') + '\n\nReturn exactly one JSON object matching the supplied schema. Do not use tools or inspect local files.';
    if (Buffer.byteLength(prompt) > 512 * 1024) throw failure('model_context_window_exhausted', 'CLI prompt exceeds the bounded input size.');
    const directory = await mkdtemp(join(tmpdir(), 'code-learning-inference-'));
    try {
      const schemaPath = join(directory, 'schema.json'), outputPath = join(directory, 'answer.json');
      await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 });
      const args = this.id === 'claude-cli'
        ? ['--restricted', '--tools', '', '--disallowedTools', 'mcp__*', '--no-session-persistence', '-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema), ...(this.model === 'default' ? [] : ['--model', this.model]), ...(this.reasoningEffort && this.reasoningEffort !== 'none' ? ['--effort', this.reasoningEffort] : [])]
        : ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--output-schema', schemaPath, '--output-last-message', outputPath, ...(this.model === 'default' ? [] : ['--model', this.model]), ...(this.reasoningEffort ? ['-c', `model_reasoning_effort="${this.reasoningEffort}"`] : []), '-'];
      const result = await runProcess(this.command, args, { cwd: directory, input: prompt, timeoutMs, signal, env: this.env, spawnProcess: this.spawnProcess, model: this.model, reasoningEffort: this.reasoningEffort });
      let value, usage = null, content;
      try {
        if (this.id === 'claude-cli') {
          const envelope = JSON.parse(result.stdout);
          if (envelope.is_error || envelope.subtype && envelope.subtype !== 'success') throw failure('model_cli_failed', 'Claude CLI did not complete the model request. Check its sign-in and model selection in Settings.');
          value = envelope.structured_output ?? JSON.parse(envelope.result);
          usage = envelope.usage ? { inputTokens: envelope.usage.input_tokens ?? null, outputTokens: envelope.usage.output_tokens ?? null, cachedInputTokens: envelope.usage.cache_read_input_tokens ?? null, reasoningTokens: null, totalTokens: null } : null;
          content = JSON.stringify(value);
        } else {
          content = await readFile(outputPath, 'utf8');
          if (Buffer.byteLength(content) > MAX_CAPTURE_BYTES) throw new Error('Output too large');
          value = JSON.parse(content);
        }
      } catch (error) { if (error?.code) throw error; throw failure('model_output_invalid_json', `${this.command} did not return a complete JSON object.`); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('model_output_invalid_json', `${this.command} did not return a JSON object.`);
      return { value, usage, model: this.model, finishReason: 'stop', outputCharacters: content.length, structuredOutputMode: 'json_schema', tokenParameter: 'cli_default', reasoningRequestMode: this.reasoningEffort ? `cli_${this.reasoningEffort}` : 'cli_default', temperatureIncluded: false };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

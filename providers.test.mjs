// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { assertModelProvider, assertSourceProvider, PROVIDER_API_VERSION } from "./providers/contracts.mjs";
import { OpenAICompatibleModelProvider, openAICompatibleInternals } from "./providers/model/openai-compatible.mjs";
import { GitHubGhSourceProvider } from "./providers/source/github-gh.mjs";
import { LocalGitSourceProvider } from "./providers/source/local-git.mjs";

test("versioned contracts reject incomplete and incompatible providers", () => {
  assert.throws(() => assertSourceProvider({ apiVersion: "2", id: "future-provider" }), /Unsupported/);
  assert.throws(() => assertModelProvider({ apiVersion: PROVIDER_API_VERSION, id: "model" }), /probeCapabilities/);
  assert.equal(assertSourceProvider({ apiVersion: PROVIDER_API_VERSION, id: "source", resolveRevision() {}, listFiles() {}, readFile() {} }).id, "source");
});

test("local Git resolves before reading and treats repository paths as data", async () => {
  const calls = [];
  const execFile = async (command, args) => {
    calls.push([command, args]);
    if (args.includes("rev-parse")) return { stdout: `${"a".repeat(40)}\n` };
    if (args.includes("ls-tree")) return { stdout: Buffer.from("src/a.js\0README.md\0") };
    return { stdout: "contents" };
  };
  const provider = new LocalGitSourceProvider({ checkout: "/tmp/example", execFile });
  const { revision } = await provider.resolveRevision("main");
  assert.equal(revision, "a".repeat(40));
  assert.deepEqual(await provider.listFiles({ revision }), ["src/a.js", "README.md"]);
  assert.equal(await provider.readFile({ revision, path: "src/a.js" }), "contents");
  assert.deepEqual(calls.at(-1)[1].slice(-2), ["show", `${revision}:src/a.js`]);
  await assert.rejects(provider.readFile({ revision, path: "../secret" }), /escape/);
});

test("GitHub gh adapter pins reads to the resolved commit", async () => {
  const calls = [];
  const sha = "b".repeat(40);
  const execFile = async (_command, args) => {
    calls.push(args);
    const endpoint = args[1];
    if (endpoint.includes("/commits/")) return { stdout: JSON.stringify({ sha }) };
    if (endpoint.includes("/git/trees/")) return { stdout: JSON.stringify({ truncated: false, tree: [{ type: "blob", path: "src/a.js" }] }) };
    return { stdout: JSON.stringify({ encoding: "base64", content: Buffer.from("hello").toString("base64") }) };
  };
  const provider = new GitHubGhSourceProvider({ repository: "example/project", execFile });
  assert.equal((await provider.resolveRevision("main")).revision, sha);
  assert.deepEqual(await provider.listFiles({ revision: sha }), ["src/a.js"]);
  assert.equal(await provider.readFile({ revision: sha, path: "src/a.js" }), "hello");
  assert.match(calls.at(-1)[1], new RegExp(`ref=${sha}$`));
});

test("OpenAI-compatible provider probes and uses strict JSON schema without exposing the key", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "quiz-model", context_length: 32_000, supported_parameters: ['response_format'], top_provider: { max_completion_tokens: 8_000 } }], capabilities: { json_schema: true } }), { status: 200 });
    return new Response(JSON.stringify({ model: "quiz-model", usage: { total_tokens: 7 }, choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  const provider = new OpenAICompatibleModelProvider({ endpoint: "https://models.example/v1", model: "quiz-model", apiKeyEnv: "QUIZ_KEY", env: { QUIZ_KEY: "secret" }, fetch });
  const capabilities = await provider.probeCapabilities();
  assert.equal(capabilities.jsonSchema, true);
  assert.equal(capabilities.contextWindowTokens, 32_000);
  assert.equal(capabilities.maxCompletionTokens, 8_000);
  const result = await provider.completeJson({ messages: [{ role: "user", content: "hello" }], schema: { type: "object" } });
  assert.deepEqual(result.value, { ok: true });
  const request = JSON.parse(calls.at(-1).options.body);
  assert.equal(request.response_format.type, "json_schema");
  assert.equal(calls.at(-1).options.headers.authorization, "Bearer secret");
  assert.equal(JSON.stringify(provider).includes("secret"), false);
});

test('OpenRouter model without response_format uses prompt-only JSON mode', async () => {
  const requests = [];
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://openrouter.ai/api/v1', model: 'fixture/prompt-json', fetch: async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture/prompt-json', supported_parameters: ['max_tokens', 'temperature'] }] }));
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
  } });
  const result = await provider.completeJson({ messages: [{ role: 'user', content: 'Return JSON.' }], schema: { type: 'object' }, maxTokens: 100 });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.structuredOutputMode, 'none');
  assert.equal(Object.hasOwn(requests[0], 'response_format'), false);
});

test('mandatory-reasoning model retries unsupported Off setting with low reasoning and caches it', async () => {
  const requests = [];
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://openrouter.ai/api/v1', model: 'fixture/mandatory-reasoning', reasoningEffort: 'none', reasoningRequestMode: 'openrouter', fetch: async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture/mandatory-reasoning', supported_parameters: ['reasoning', 'response_format', 'max_tokens'] }] }));
    const body = JSON.parse(options.body); requests.push(body);
    if (body.reasoning?.effort === 'none') return new Response(JSON.stringify({ error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400 } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
  } });
  const request = { messages: [{ role: 'user', content: 'Return JSON.' }], schema: { type: 'object' }, maxTokens: 100 };
  const first = await provider.completeJson(request);
  assert.equal(first.reasoningRequestMode, 'openrouter_low_fallback');
  assert.deepEqual(requests.map((body) => body.reasoning?.effort ?? null), ['none', 'low']);
  await provider.completeJson(request);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].reasoning, { effort: 'low', exclude: true });
});

test('agentic-harness-only free model reports access restriction without provider text', async () => {
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://openrouter.ai/api/v1', model: 'fixture/harness-restricted-free', fetch: async (url) => url.endsWith('/models')
    ? new Response(JSON.stringify({ data: [{ id: 'fixture/harness-restricted-free', supported_parameters: ['max_tokens'] }] }))
    : new Response(JSON.stringify({ error: { message: 'Only available on agentic harnesses. private-provider-detail' } }), { status: 403 }) });
  await assert.rejects(provider.completeJson({ messages: [{ role: 'user', content: 'Return JSON.' }], schema: { type: 'object' } }), (error) => {
    assert.equal(error.code, 'model_provider_access_restricted');
    assert.equal(error.retryable, false);
    assert.equal(JSON.stringify(error).includes('private-provider-detail'), false);
    return true;
  });
});

test('OpenRouter age confirmation is classified without exposing response text', async () => {
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://openrouter.ai/api/v1', model: 'fixture/age-restricted', fetch: async (url) => url.endsWith('/models')
    ? new Response(JSON.stringify({ data: [{ id: 'fixture/age-restricted', supported_parameters: ['response_format'] }] }))
    : new Response(JSON.stringify({ error: { message: 'This model requires 18+ age confirmation before use. private-provider-detail' } }), { status: 403 }) });
  await assert.rejects(provider.completeJson({ messages: [{ role: 'user', content: 'Return JSON.' }], schema: { type: 'object' } }), (error) => {
    assert.equal(error.code, 'model_provider_age_confirmation_required');
    assert.equal(error.retryable, false);
    assert.equal(JSON.stringify(error).includes('private-provider-detail'), false);
    return true;
  });
});

test("OpenAI-compatible provider propagates cancellation", async () => {
  const controller = new AbortController(); controller.abort();
  const fetch = async (_url, { signal }) => { signal.throwIfAborted(); };
  const provider = new OpenAICompatibleModelProvider({ endpoint: "http://localhost:1234/v1", model: "m", fetch });
  await assert.rejects(provider.probeCapabilities({ signal: controller.signal }), { name: "AbortError" });
});

test('model provider requires TLS away from loopback', () => {
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'http://models.example/v1', model: 'm' }), /HTTPS/);
  assert.doesNotThrow(() => new OpenAICompatibleModelProvider({ endpoint: 'http://127.0.0.1:8080/v1', model: 'm' }));
});

test('model provider rejects malformed configuration and unsafe request overrides', async () => {
  for (const endpoint of [undefined, 'relative/v1', 'ftp://models.example', 'https://user:pass@models.example/v1', 'https://models.example/v1?q=1', 'https://models.example/v1#x']) {
    assert.throws(() => new OpenAICompatibleModelProvider({ endpoint, model: 'm' }), /absolute URL|HTTP\(S\) base URL/);
  }
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: ' ' }), /model name/);
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', apiKeyEnv: 'bad-key' }), /environment variable/);
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', apiKeyEnv: null }), /unless authMode is none/);
  assert.doesNotThrow(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', apiKeyEnv: null, authMode: 'none' }));
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'sometimes' }), /jsonSchema/);
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', reasoningEffort: 'not valid' }), /reasoningEffort/);
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', authMode: 'basic' }), /authMode/);
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', reasoningRequestMode: 'native' }), /reasoningRequestMode/);
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', responseMaxBytes: 0 }), /responseMaxBytes/);
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', fetch: null }), /fetch/);
  assert.doesNotThrow(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1/', model: 'm', timeoutMs: 1 }));
  assert.doesNotThrow(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', timeoutMs: 300_000 }));
  assert.throws(() => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', timeoutMs: 300_001 }), /timeoutMs/);

  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'disabled', fetch: async () => new Response('{}') });
  const base = { messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' } };
  await assert.rejects(provider.completeJson({ ...base, messages: [] }), /messages/);
  await assert.rejects(provider.completeJson({ ...base, messages: 'x' }), /messages/);
  await assert.rejects(provider.completeJson({ ...base, schema: undefined }), /schema/);
  await assert.rejects(provider.completeJson({ ...base, schema: [] }), /schema/);
  await assert.rejects(provider.completeJson({ ...base, schemaName: 'spaces fail' }), /schemaName/);
  await assert.rejects(provider.completeJson({ ...base, schemaName: 'x'.repeat(65) }), /schemaName/);
  await assert.rejects(provider.completeJson({ ...base, temperature: -1 }), /temperature/);
  await assert.rejects(provider.completeJson({ ...base, temperature: 2.1 }), /temperature/);
  await assert.rejects(provider.completeJson({ ...base, temperature: Number.NaN }), /temperature/);
  await assert.rejects(provider.completeJson({ ...base, maxTokens: 0 }), /maxTokens/);
  await assert.rejects(provider.completeJson({ ...base, maxTokens: 1.5 }), /maxTokens/);
  await assert.rejects(provider.completeJson({ ...base, timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(provider.completeJson({ ...base, timeoutMs: 300_001 }), /timeoutMs/);
  await assert.rejects(provider.completeJson({ ...base, capabilityTimeoutMs: 30_001 }), /capabilityTimeoutMs/);
  await assert.rejects(provider.completeJson({ ...base, requestExtensions: [] }), /requestExtensions/);
  await assert.rejects(provider.completeJson({ ...base, requestExtensions: null }), /requestExtensions/);
  await assert.rejects(provider.completeJson({ ...base, requestExtensions: { model: 'attacker-model' } }), /cannot override/);
  for (const reserved of ['messages', 'temperature', 'max_tokens', 'reasoning', 'reasoning_effort', 'response_format']) await assert.rejects(provider.completeJson({ ...base, requestExtensions: { [reserved]: 'override' } }), /cannot override/);
  await assert.rejects(provider.probeCapabilities({ timeoutMs: 30_001 }), /Capability timeoutMs/);
});

test('model provider reports probe HTTP, JSON, advertisement, and required-schema states', async () => {
  const httpFailure = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', fetch: async () => new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401 }) });
  await assert.rejects(httpFailure.probeCapabilities(), (error) => error.message === 'Model capability probe failed with HTTP 401' && error.code === 'model_provider_http_error' && error.status === 401 && error.retryable === false);
  const invalidJson = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', fetch: async () => new Response('not-json') });
  await assert.rejects(invalidJson.probeCapabilities(), /invalid JSON/);
  const absent = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'wanted', fetch: async () => new Response(JSON.stringify({ data: [{ id: 'other' }], capabilities: { json_schema: false } })) });
  assert.deepEqual(await absent.probeCapabilities(), { model: 'wanted', modelAdvertised: false, jsonSchema: false, cancellation: true, contextWindowTokens: null, maxCompletionTokens: null, supportedParameters: [] });
  const advertised = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'wanted', fetch: async () => new Response(JSON.stringify({ data: [{ id: 'wanted' }], capabilities: { json_schema: true } })) });
  assert.deepEqual(await advertised.probeCapabilities(), { model: 'wanted', modelAdvertised: true, jsonSchema: true, cancellation: true, contextWindowTokens: null, maxCompletionTokens: null, supportedParameters: [] });
  const required = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'required', fetch: async (url) => url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'm' }], capabilities: { json_schema: false } })) : new Response(JSON.stringify({ error: { message: 'json_schema unsupported' } }), { status: 400 }) });
  await assert.rejects(required.completeJson({ messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' } }), (error) => error.message === 'Model completion failed with HTTP 400' && error.retryable === false);
});

test('disabled JSON schema mode sends immutable core fields and bounded extensions', async () => {
  const calls = [];
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1/', model: 'm', jsonSchema: 'disabled', env: {}, fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm' }], capabilities: { json_schema: true } }));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
  } });
  const result = await provider.completeJson({ messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' }, schemaName: 'safe_name', temperature: 2, maxTokens: 1, timeoutMs: 1, requestExtensions: { seed: 7 } });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.authorization, undefined);
  const request = JSON.parse(calls[1].options.body);
  assert.deepEqual(request.response_format, { type: 'json_object' });
  assert.equal(request.model, 'm'); assert.equal(request.max_tokens, 1); assert.equal(request.seed, 7); assert.equal(request.temperature, 2);
});

test('model provider classifies completion failures without leaking response bodies', async () => {
  const completeWith = (completion) => new OpenAICompatibleModelProvider({
    endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'disabled',
    fetch: async (url) => url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'm' }] })) : completion(),
  });
  await assert.rejects(completeWith(() => new Response(JSON.stringify({ message: 'overloaded-secret' }), { status: 503 })).completeJson({ messages: [{}], schema: {} }), (error) => error.message === 'Model completion failed with HTTP 503' && !error.message.includes('secret') && error.retryable === true);
  await assert.rejects(completeWith(() => new Response('not-json')).completeJson({ messages: [{}], schema: {} }), /invalid JSON/);
  await assert.rejects(completeWith(() => new Response(JSON.stringify({ choices: [{}] }, null, 0))).completeJson({ messages: [{}], schema: {} }), /did not contain message content/);

  const truncated = completeWith(() => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }], usage: { completion_tokens: 42 } })));
  await assert.rejects(truncated.completeJson({ messages: [{}], schema: {} }), (error) => error.code === 'model_output_truncated' && error.diagnostics.completion_tokens === 42 && error.diagnostics.content_chars === 11 && error.usage.outputTokens === 42);
  const alternateTruncation = completeWith(() => new Response(JSON.stringify({ choices: [{ finish_reason: 'max_tokens', message: { content: '{}' } }] })));
  await assert.rejects(alternateTruncation.completeJson({ messages: [{}], schema: {} }), (error) => error.code === 'model_output_truncated' && error.diagnostics.finish_reason === 'max_tokens');
  const malformed = completeWith(() => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{bad}' } }], usage: { completion_tokens: 3 } })));
  await assert.rejects(malformed.completeJson({ messages: [{}], schema: {} }), (error) => error.code === 'model_output_invalid_json' && error.diagnostics.finish_reason === 'stop' && error.usage.outputTokens === 3);
});

test('message-only unsupported-field errors negotiate narrowly', async () => {
  const requests = [];
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', fetch: async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm' }] }));
    const body = JSON.parse(options.body); requests.push(body);
    if (body.response_format.type === 'json_schema') return new Response(JSON.stringify({ error: { message: 'response_format is not supported by this model' } }), { status: 400 });
    if (body.max_tokens) return new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: 'max_tokens'" } }), { status: 422 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }));
  } });
  const result = await provider.completeJson({ messages: [{}], schema: {}, maxTokens: 10 });
  assert.equal(result.structuredOutputMode, 'json_object');
  assert.equal(result.tokenParameter, 'max_completion_tokens');
  assert.equal(requests.length, 3);

  let posts = 0;
  const unrelated = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'missing', fetch: async (url) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
    posts += 1; return new Response(JSON.stringify({ error: { message: 'Unknown model; max_tokens cannot be evaluated' } }), { status: 400 });
  } });
  await assert.rejects(unrelated.completeJson({ messages: [{}], schema: {}, maxTokens: 10 }), /HTTP 400/);
  assert.equal(posts, 1, 'an unrelated model error must not trigger field negotiation');
});

test('auto schema and token modes negotiate only attributable errors and cache the learned combination', async () => {
  const requests = [];
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', fetch: async (url, options) => {
    if (url.endsWith('/models')) return new Response('not implemented', { status: 404 });
    const body = JSON.parse(options.body); requests.push(body);
    if (body.response_format.type === 'json_schema') return new Response(JSON.stringify({ error: { message: 'unsupported request field', param: 'response_format', code: 'unsupported_response_format' } }), { status: 400 });
    if (body.max_tokens) return new Response(JSON.stringify({ error: { message: 'unsupported request field', param: 'max_tokens', code: 'unsupported_max_tokens' } }), { status: 422 });
    return new Response(JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
  } });
  const result = await provider.completeJson({ messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' }, maxTokens: 10 });
  assert.equal(result.structuredOutputMode, 'json_object');
  assert.equal(result.tokenParameter, 'max_completion_tokens');
  await provider.completeJson({ messages: [{ role: 'user', content: 'again' }], schema: { type: 'object' }, maxTokens: 10 });
  assert.deepEqual(requests.map(({ response_format, max_tokens, max_completion_tokens }) => [response_format.type, Boolean(max_tokens), Boolean(max_completion_tokens)]), [['json_schema', true, false], ['json_object', true, false], ['json_object', false, true], ['json_object', false, true]]);
});

test('request semantics adapt token field, temperature, system role, reasoning, and usage', async () => {
  let request;
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', tokenParameter: 'auto', temperatureMode: 'auto', systemInstructionMode: 'developer', reasoningEffort: 'low', fetch: async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm', supported_parameters: ['max_completion_tokens', 'response_format'] }] }));
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ model: 'resolved-m', usage: { prompt_tokens: 11, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 3 }, prompt_tokens_details: { cached_tokens: 2 }, total_tokens: 18 }, choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }));
  } });
  const result = await provider.completeJson({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'x' }], schema: { type: 'object' }, temperature: 0.4, maxTokens: 123 });
  assert.equal(request.max_completion_tokens, 123);
  assert.equal(request.max_tokens, undefined);
  assert.equal(request.temperature, undefined);
  assert.equal(request.messages[0].role, 'developer');
  assert.equal(request.reasoning_effort, 'low');
  assert.equal(request.reasoning, undefined);
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, reasoningTokens: 3, cachedInputTokens: 2, totalTokens: 18 });
  assert.equal(result.model, 'resolved-m');
  assert.equal(result.reasoningRequestMode, 'openai');
  assert.equal(result.temperatureIncluded, false);
});

test('user-prefix mode preserves system instructions for endpoints without system roles', async () => {
  let request;
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'disabled', systemInstructionMode: 'user-prefix', fetch: async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm' }] }));
    request = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
  } });
  await provider.completeJson({ messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'question' }], schema: {} });
  assert.deepEqual(request.messages, [{ role: 'user', content: 'Instructions:\nrules\n\nquestion' }]);
});

test('auto token mode retries the alternate Chat Completions limit field', async () => {
  const requests = [];
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'disabled', fetch: async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm' }] }));
    const body = JSON.parse(options.body); requests.push(body);
    if (body.max_tokens) return new Response(JSON.stringify({ error: { message: 'use max_completion_tokens', param: 'max_tokens', code: 'unsupported_max_tokens' } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
  } });
  const result = await provider.completeJson({ messages: [{ role: 'user', content: 'x' }], schema: {}, maxTokens: 99 });
  assert.equal(result.tokenParameter, 'max_completion_tokens');
  assert.deepEqual(requests.map((request) => Object.hasOwn(request, 'max_completion_tokens')), [false, true]);
});

test('authentication mode supports API-key headers, anonymous endpoints, and missing-key failures', async () => {
  let headers;
  const xApiKey = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', authMode: 'x-api-key', apiKeyEnv: 'MODEL_KEY', env: { MODEL_KEY: 'secret' }, fetch: async (_url, options) => { headers = options.headers; return new Response(JSON.stringify({ data: [] })); } });
  await xApiKey.probeCapabilities();
  assert.equal(headers['x-api-key'], 'secret'); assert.equal(headers.authorization, undefined);
  const anonymous = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', authMode: 'none', apiKeyEnv: 'MODEL_KEY', env: { MODEL_KEY: 'ignored' }, fetch: async (_url, options) => { headers = options.headers; return new Response(JSON.stringify({ data: [] })); } });
  await anonymous.probeCapabilities();
  assert.equal(headers['x-api-key'], undefined); assert.equal(headers.authorization, undefined);
  const missing = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', authMode: 'bearer', apiKeyEnv: 'MODEL_KEY', env: {}, fetch: async () => new Response('{}') });
  await assert.rejects(missing.probeCapabilities(), (error) => error.code === 'model_provider_credential_missing' && error.retryable === false);
  await assert.rejects(missing.capabilitiesOrUnknown(), (error) => error.code === 'model_provider_credential_missing' && error.retryable === false);
});

test('completion metadata is bounded to scalar values and response errors retain normalized usage', async () => {
  const completeWith = (body) => new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'configured-model', jsonSchema: 'disabled', fetch: async (url) => url.endsWith('/models')
    ? new Response(JSON.stringify({ data: [{ id: 'configured-model' }] })) : new Response(JSON.stringify(body)) });
  const longModel = 'm'.repeat(400), longFinish = 'custom-'.repeat(60);
  const bounded = await completeWith({ model: longModel, choices: [{ finish_reason: longFinish, message: { content: '{}' } }] }).completeJson({ messages: [{}], schema: {} });
  assert.equal(bounded.model.length, 256); assert.equal(bounded.finishReason.length, 256);
  assert.equal(bounded.reasoningRequestMode, 'disabled'); assert.equal(bounded.temperatureIncluded, true);
  const fallback = await completeWith({ model: { unsafe: true }, choices: [{ finish_reason: ['stop'], message: { content: '{}' } }] }).completeJson({ messages: [{}], schema: {} });
  assert.equal(fallback.model, 'configured-model'); assert.equal(fallback.finishReason, 'unknown');
  await assert.rejects(completeWith({ usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, choices: [{}] }).completeJson({ messages: [{}], schema: {} }), (error) => error.code === 'model_provider_invalid_response' && error.usage.totalTokens === 3);
});

test('model provider disables redirects for both discovery and completion', async () => {
  const calls = [];
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'disabled', fetch: async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'm' }] })) : new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
  } });
  await provider.completeJson({ messages: [{}], schema: {} });
  assert.deepEqual(calls.map(({ options }) => options.redirect), ['error', 'error']);
});

test('bounded response reader rejects oversized chunked bodies without exposing content', async () => {
  const secret = 'private-provider-payload';
  const stream = () => new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(secret));
      controller.enqueue(new TextEncoder().encode(secret));
      controller.close();
    },
  });
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'disabled', responseMaxBytes: 24, fetch: async (url) => url.endsWith('/models')
    ? new Response(JSON.stringify({ data: [{ id: 'm' }] }))
    : new Response(stream()) });
  await assert.rejects(provider.completeJson({ messages: [{}], schema: {} }), (error) => error.code === 'model_provider_response_too_large' && error.retryable === false && !error.message.includes(secret));
});

test('HTTP failures expose bounded classification but never provider body text', async () => {
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'disabled', fetch: async (url) => url.endsWith('/models')
    ? new Response(JSON.stringify({ data: [{ id: 'm' }] }))
    : new Response(JSON.stringify({ error: { message: 'credential=very-secret', code: 'invalid_request_error', param: 'max_tokens', type: 'invalid_request' } }), { status: 400 }) });
  await assert.rejects(provider.completeJson({ messages: [{}], schema: {} }), (error) => {
    assert.equal(error.message, 'Model completion failed with HTTP 400');
    assert.equal(error.providerCode, 'invalid_request_error');
    assert.equal(error.providerParam, 'max_tokens');
    assert.equal(error.providerType, 'invalid_request');
    assert.equal(error.retryable, false);
    assert.equal(JSON.stringify(error).includes('very-secret'), false);
    return true;
  });
});

test('generic and non-negotiable HTTP errors perform exactly one completion POST', async () => {
  for (const status of [400, 404]) {
    let posts = 0;
    const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', fetch: async (url) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm' }] }));
      posts += 1; return new Response(JSON.stringify({ error: { message: 'generic failure' } }), { status });
    } });
    await assert.rejects(provider.completeJson({ messages: [{}], schema: {}, maxTokens: 10 }), (error) => error.status === status);
    assert.equal(posts, 1);
  }
});

test('capability timeout degrades to unknown but caller cancellation remains cancellation', async () => {
  let completion;
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'disabled', fetch: async (url, { signal }) => {
    if (url.endsWith('/models')) return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    completion = true; return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
  } });
  const result = await provider.completeJson({ messages: [{}], schema: {}, timeoutMs: 100, capabilityTimeoutMs: 5 });
  assert.deepEqual(result.value, {}); assert.equal(completion, true); assert.equal(provider.capabilities.probeError, 'TimeoutError');

  const controller = new AbortController(); controller.abort();
  const cancelled = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', fetch: provider.fetch });
  await assert.rejects(cancelled.completeJson({ messages: [{}], schema: {}, signal: controller.signal }), { name: 'AbortError' });
});

test('completion negotiation uses one aggregate deadline and timeout is retryable', async () => {
  let posts = 0;
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', fetch: async (url, { signal }) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm' }] }));
    posts += 1;
    if (posts === 1) return new Response(JSON.stringify({ error: { param: 'response_format', code: 'unsupported_response_format' } }), { status: 400 });
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  // AbortSignal.timeout is unreferenced on Node 20. A real socket holds the
  // event loop open, so the injected hanging fetch needs an equivalent handle.
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await assert.rejects(provider.completeJson({ messages: [{}], schema: {}, timeoutMs: 20 }), (error) => error.code === 'model_provider_timeout' && error.retryable === true);
    assert.equal(posts, 2);
  } finally { clearTimeout(keepAlive); }
});

test('reasoning request modes emit OpenAI and OpenRouter shapes', async () => {
  async function capture(reasoningRequestMode, supported_parameters) {
    let request;
    const provider = new OpenAICompatibleModelProvider({ endpoint: 'https://models.example/v1', model: 'm', jsonSchema: 'disabled', reasoningEffort: 'medium', reasoningRequestMode, fetch: async (url, options) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm', supported_parameters }] }));
      request = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
    } });
    await provider.completeJson({ messages: [{}], schema: {} }); return request;
  }
  const unknownAuto = await capture('auto', []);
  assert.equal(unknownAuto.reasoning_effort, 'medium'); assert.equal(unknownAuto.reasoning, undefined);
  const advertisedOpenRouter = await capture('auto', ['reasoning']);
  assert.deepEqual(advertisedOpenRouter.reasoning, { effort: 'medium', exclude: true }); assert.equal(advertisedOpenRouter.reasoning_effort, undefined);
  const forcedOpenAI = await capture('openai', ['reasoning']);
  assert.equal(forcedOpenAI.reasoning_effort, 'medium');
  const disabled = await capture('disabled', ['reasoning']);
  assert.equal(disabled.reasoning, undefined); assert.equal(disabled.reasoning_effort, undefined);
});

test('bounded response decoder preserves split UTF8 and releases its reader', async () => {
  const { boundedText } = openAICompatibleInternals;
  const text = JSON.stringify({ value: '問題 🔬' });
  const bytes = new TextEncoder().encode(text);
  for (let split = 1; split < bytes.length; split += 1) {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close(); } }));
    assert.equal(await boundedText(response, bytes.length), text);
    assert.equal(response.body.locked, false);
  }
  const bytewise = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
  assert.equal(JSON.parse(await boundedText(bytewise, bytes.length)).value, '問題 🔬');
  assert.equal(bytewise.body.locked, false);
  assert.equal(await boundedText(new Response(null), 0), '');
  const empty = new Response(new ReadableStream({ start(controller) { controller.close(); } }));
  assert.equal(await boundedText(empty, 0), ''); assert.equal(empty.body.locked, false);
  const invalid = new Response(Uint8Array.of(0xff));
  assert.equal(await boundedText(invalid, 1), '\ufffd'); assert.equal(invalid.body.locked, false);
  const oversized = new Response(bytes);
  await assert.rejects(boundedText(oversized, bytes.length - 1), { code: 'model_provider_response_too_large', retryable: false });
  assert.equal(oversized.body.locked, false);
});
test('invalid provider JSON is a permanent error rather than a retry signal', async () => {
  let requests = 0;
  const provider = new OpenAICompatibleModelProvider({ endpoint: 'http://127.0.0.1:1/v1', model: 'synthetic', authMode: 'none', jsonSchema: 'disabled', fetch: async (url) => { if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] })); requests += 1; return new Response('not-json'); } });
  await assert.rejects(provider.completeJson({ messages: [{ role: 'user', content: 'Fixture' }], schema: { type: 'object' } }), { code: 'model_provider_invalid_json', retryable: false });
  assert.equal(requests, 1);
});

for (const length of [39, 40, 64, 65]) test(`local Git object IDs enforce length ${length} at every provider boundary`, async () => {
  const revision = 'A'.repeat(length); const calls = [];
  const provider = new LocalGitSourceProvider({ checkout: '/tmp/example', execFile: async (_command, args) => {
    calls.push(args);
    return { stdout: args.includes('rev-parse') ? `${revision}\n` : args.includes('ls-tree') ? Buffer.from('src/a.js\0') : 'committed content' };
  } });
  if (length === 40 || length === 64) {
    assert.equal((await provider.resolveRevision('main')).revision, revision.toLowerCase());
    assert.deepEqual(await provider.listFiles({ revision }), ['src/a.js']);
    assert.equal(await provider.readFile({ revision, path: 'src/a.js' }), 'committed content');
    assert.equal(calls.length, 3);
  } else {
    await assert.rejects(provider.resolveRevision('main'), /invalid object id/);
    await assert.rejects(provider.listFiles({ revision }), /resolved revision object id/);
    await assert.rejects(provider.readFile({ revision, path: 'src/a.js' }), /resolved revision object id/);
    assert.equal(calls.length, 1, 'invalid caller IDs must not launch Git');
  }
});

test('local Git rejects nonhex object IDs at every provider boundary', async () => {
  for (const revision of ['g' + 'a'.repeat(39), 'a'.repeat(39) + '-', 'a'.repeat(20) + ' ' + 'a'.repeat(19)]) {
    let calls = 0;
    const provider = new LocalGitSourceProvider({ checkout: '/tmp/example', execFile: async () => { calls++; return { stdout: revision }; } });
    await assert.rejects(provider.resolveRevision('main'), /invalid object id/);
    await assert.rejects(provider.listFiles({ revision }), /resolved revision object id/);
    await assert.rejects(provider.readFile({ revision, path: 'src/a.js' }), /resolved revision object id/);
    assert.equal(calls, 1);
  }
});

test('local Git filename listing preserves bounded execution and buffer error details', async () => {
  const controller = new AbortController();
  const provider = new LocalGitSourceProvider({ checkout: '/tmp/example', timeoutMs: 1234, execFile: async (_command, _args, options) => {
    assert.equal(options.encoding, 'buffer'); assert.equal(options.timeout, 1234);
    assert.equal(options.maxBuffer, 32 * 1024 * 1024); assert.equal(options.signal, controller.signal);
    throw Object.assign(new Error('Git failed'), { stderr: Buffer.from('controlled missing object\n') });
  } });
  await assert.rejects(provider.listFiles({ revision: 'a'.repeat(40), signal: controller.signal }), /Local Git operation failed: controlled missing object/);
});

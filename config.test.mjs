// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, publicConfig } from "./config.mjs";

test("config precedence is defaults, file, environment, then explicit overrides", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "quiz-config-"));
  const file = path.join(directory, "config.json");
  await writeFile(file, JSON.stringify({ model: { model: "from-file", timeoutMs: 10_000 }, source: { checkout: "./repo" } }));
  const config = await loadConfig({
    configFile: file,
    env: { CODE_LEARNING_MODEL: "from-env", CODE_LEARNING_MODEL_TIMEOUT_MS: "20000", CODE_LEARNING_MODEL_MAX_OUTPUT_TOKENS: "5000", CODE_LEARNING_MODEL_RETRY_MAX_OUTPUT_TOKENS: "9000", CODE_LEARNING_MODEL_REASONING_MODE: "openai", CODE_LEARNING_MODEL_REASONING_EFFORT: "low", CODE_LEARNING_MODEL_CONTEXT_WINDOW_TOKENS: "32000", CODE_LEARNING_MODEL_MAX_COMPLETION_TOKENS: "12000", CODE_LEARNING_MODEL_TOKEN_PARAMETER: "max_completion_tokens", CODE_LEARNING_MODEL_TEMPERATURE_MODE: "disabled", CODE_LEARNING_MODEL_SYSTEM_INSTRUCTION_MODE: "developer", CODE_LEARNING_MODEL_AUTH_MODE: "x-api-key", CODE_LEARNING_MODEL_SOURCE_EGRESS: "remote", CODE_LEARNING_REVIEW_MODEL: "reviewer", CODE_LEARNING_REVIEW_MODEL_ENDPOINT: "https://review.example/v1", CODE_LEARNING_REVIEW_MODEL_API_KEY_ENV: "REVIEW_KEY", CODE_LEARNING_REVIEW_MODEL_AUTH_MODE: "bearer", CODE_LEARNING_REVIEW_MODEL_TIMEOUT_MS: "30000", CODE_LEARNING_REVIEW_MODEL_JSON_SCHEMA: "required", CODE_LEARNING_REVIEW_MODEL_MAX_OUTPUT_TOKENS: "6000", CODE_LEARNING_REVIEW_MODEL_RETRY_MAX_OUTPUT_TOKENS: "10000", CODE_LEARNING_REVIEW_MODEL_CONTEXT_WINDOW_TOKENS: "64000", CODE_LEARNING_REVIEW_MODEL_MAX_COMPLETION_TOKENS: "16000", CODE_LEARNING_REVIEW_MODEL_TOKEN_PARAMETER: "max_tokens", CODE_LEARNING_REVIEW_MODEL_TEMPERATURE_MODE: "enabled", CODE_LEARNING_REVIEW_MODEL_SYSTEM_INSTRUCTION_MODE: "user-prefix", CODE_LEARNING_REVIEW_MODEL_REASONING_MODE: "openrouter", CODE_LEARNING_REVIEW_MODEL_REASONING_EFFORT: "medium", CODE_LEARNING_REVIEW_MODEL_SOURCE_EGRESS: "remote" },
    overrides: { model: { model: "from-override" } },
  });
  assert.equal(config.model.model, "from-override");
  assert.equal(config.model.timeoutMs, 20_000);
  assert.equal(config.model.endpoint, "http://127.0.0.1:11434/v1");
  assert.equal(config.model.maxOutputTokens, 5_000);
  assert.equal(config.model.retryMaxOutputTokens, 9_000);
  assert.equal(config.model.reasoningEffort, "low");
  assert.equal(config.model.reasoningMode, "openai");
  assert.equal(config.model.contextWindowTokens, 32_000);
  assert.equal(config.model.maxCompletionTokens, 12_000);
  assert.equal(config.model.tokenParameter, "max_completion_tokens");
  assert.equal(config.model.temperatureMode, "disabled");
  assert.equal(config.model.systemInstructionMode, "developer");
  assert.equal(config.model.authMode, "x-api-key");
  assert.equal(config.model.sourceEgress, "remote");
  assert.equal(config.model.reviewModel, "reviewer");
  assert.equal(config.model.reviewEndpoint, "https://review.example/v1");
  assert.equal(config.model.reviewApiKeyEnv, "REVIEW_KEY");
  assert.equal(config.model.reviewAuthMode, "bearer");
  assert.equal(config.model.reviewTimeoutMs, 30_000);
  assert.equal(config.model.reviewJsonSchema, "required");
  assert.equal(config.model.reviewMaxOutputTokens, 6_000);
  assert.equal(config.model.reviewRetryMaxOutputTokens, 10_000);
  assert.equal(config.model.reviewContextWindowTokens, 64_000);
  assert.equal(config.model.reviewMaxCompletionTokens, 16_000);
  assert.equal(config.model.reviewTokenParameter, "max_tokens");
  assert.equal(config.model.reviewTemperatureMode, "enabled");
  assert.equal(config.model.reviewSystemInstructionMode, "user-prefix");
  assert.equal(config.model.reviewReasoningMode, "openrouter");
  assert.equal(config.model.reviewReasoningEffort, "medium");
  assert.equal(config.model.reviewSourceEgress, "remote");
  assert.equal(path.isAbsolute(config.source.checkout), true);
  assert.equal(Object.isFrozen(config.model), true);
});

test("config rejects unknown keys, inline secrets, invalid provider values, and bad environment numbers", async () => {
  await assert.rejects(loadConfig({ overrides: { unexpected: true } }), /Unknown configuration key/);
  await assert.rejects(loadConfig({ overrides: { model: { apiKey: "secret" } } }), /Unknown configuration key/);
  await assert.rejects(loadConfig({ overrides: { source: { provider: "magic" } } }), /source.provider/);
  await assert.rejects(loadConfig({ env: { CODE_LEARNING_MODEL_TIMEOUT_MS: "not-a-number" } }), /timeoutMs/);
  await assert.rejects(loadConfig({ env: { CODE_LEARNING_MODEL_MAX_OUTPUT_TOKENS: "255" } }), /maxOutputTokens/);
  await assert.rejects(loadConfig({ overrides: { model: { maxOutputTokens: 10_000, retryMaxOutputTokens: 9_000 } } }), /retryMaxOutputTokens/);
  await assert.rejects(loadConfig({ overrides: { model: { reasoningEffort: "not valid" } } }), /reasoningEffort/);
  await assert.rejects(loadConfig({ env: { CODE_LEARNING_MODEL_CONTEXT_WINDOW_TOKENS: "511" } }), /contextWindowTokens/);
  await assert.rejects(loadConfig({ env: { CODE_LEARNING_MODEL_MAX_COMPLETION_TOKENS: "255" } }), /maxCompletionTokens/);
  await assert.rejects(loadConfig({ overrides: { model: { endpoint: 'http://models.example/v1' } } }), /HTTPS/);
  await assert.rejects(loadConfig({ overrides: { model: { endpoint: 'https://models.example/v1?tenant=a' } } }), /query/);
  await assert.rejects(loadConfig({ overrides: { model: { endpoint: 'https://models.example/v1#unsafe' } } }), /fragment/);
  await assert.rejects(loadConfig({ overrides: { model: { tokenParameter: 'max_output_tokens' } } }), /tokenParameter/);
  await assert.rejects(loadConfig({ overrides: { model: { temperatureMode: 'sometimes' } } }), /temperatureMode/);
  await assert.rejects(loadConfig({ overrides: { model: { systemInstructionMode: 'assistant' } } }), /systemInstructionMode/);
  await assert.rejects(loadConfig({ overrides: { model: { authMode: 'basic' } } }), /authMode/);
  await assert.rejects(loadConfig({ overrides: { model: { sourceEgress: 'maybe' } } }), /sourceEgress/);
  await assert.rejects(loadConfig({ overrides: { model: { reasoningMode: 'provider-magic' } } }), /reasoningMode/);
  await assert.rejects(loadConfig({ overrides: { model: { endpoint: 'https://models.example/v1', sourceEgress: 'local' } } }), /sourceEgress=local/);
  await assert.rejects(loadConfig({ overrides: { model: { reviewEndpoint: 'http://review.example/v1' } } }), /reviewEndpoint/);
});

test("same-endpoint reviewer inherits every compatibility, credential, reasoning, and egress setting", async () => {
  const config = await loadConfig({ overrides: { model: {
    endpoint: "https://models.example/v1/", model: "generator", apiKeyEnv: "GENERATOR_KEY", authMode: "x-api-key",
    timeoutMs: 12_000, jsonSchema: "required", maxOutputTokens: 3_000, retryMaxOutputTokens: 7_000,
    contextWindowTokens: 24_000, maxCompletionTokens: 9_000, tokenParameter: "max_completion_tokens",
    temperatureMode: "disabled", systemInstructionMode: "developer", reasoningMode: "openrouter",
    reasoningEffort: "high", sourceEgress: "remote", reviewEndpoint: "https://models.example/v1",
  } } });
  assert.deepEqual({
    endpoint: config.model.reviewEndpoint, model: config.model.reviewModel, apiKeyEnv: config.model.reviewApiKeyEnv,
    authMode: config.model.reviewAuthMode, timeoutMs: config.model.reviewTimeoutMs, jsonSchema: config.model.reviewJsonSchema,
    maxOutputTokens: config.model.reviewMaxOutputTokens, retryMaxOutputTokens: config.model.reviewRetryMaxOutputTokens,
    contextWindowTokens: config.model.reviewContextWindowTokens, maxCompletionTokens: config.model.reviewMaxCompletionTokens,
    tokenParameter: config.model.reviewTokenParameter, temperatureMode: config.model.reviewTemperatureMode,
    systemInstructionMode: config.model.reviewSystemInstructionMode, reasoningMode: config.model.reviewReasoningMode,
    reasoningEffort: config.model.reviewReasoningEffort, sourceEgress: config.model.reviewSourceEgress,
  }, {
    endpoint: "https://models.example/v1", model: "generator", apiKeyEnv: "GENERATOR_KEY", authMode: "x-api-key",
    timeoutMs: 12_000, jsonSchema: "required", maxOutputTokens: 3_000, retryMaxOutputTokens: 7_000,
    contextWindowTokens: 24_000, maxCompletionTokens: 9_000, tokenParameter: "max_completion_tokens",
    temperatureMode: "disabled", systemInstructionMode: "developer", reasoningMode: "openrouter",
    reasoningEffort: "high", sourceEgress: "remote",
  });
});

test("same-endpoint reviewer with a different model uses independent compatibility defaults", async () => {
  const config = await loadConfig({ overrides: { model: {
    endpoint: "https://models.example/v1", model: "generator", apiKeyEnv: "SHARED_KEY", authMode: "bearer",
    timeoutMs: 12_000, jsonSchema: "required", maxOutputTokens: 3_000, retryMaxOutputTokens: 7_000,
    contextWindowTokens: 24_000, maxCompletionTokens: 9_000, tokenParameter: "max_completion_tokens",
    temperatureMode: "disabled", systemInstructionMode: "developer", reasoningMode: "openrouter", reasoningEffort: "high",
    reviewModel: "reviewer",
  } } });
  assert.equal(config.model.reviewEndpoint, "https://models.example/v1");
  assert.equal(config.model.reviewModel, "reviewer");
  assert.equal(config.model.reviewApiKeyEnv, "SHARED_KEY", "credentials remain endpoint-scoped");
  assert.equal(config.model.reviewAuthMode, "bearer");
  assert.deepEqual({
    timeoutMs: config.model.reviewTimeoutMs, jsonSchema: config.model.reviewJsonSchema,
    maxOutputTokens: config.model.reviewMaxOutputTokens, retryMaxOutputTokens: config.model.reviewRetryMaxOutputTokens,
    contextWindowTokens: config.model.reviewContextWindowTokens, maxCompletionTokens: config.model.reviewMaxCompletionTokens,
    tokenParameter: config.model.reviewTokenParameter, temperatureMode: config.model.reviewTemperatureMode,
    systemInstructionMode: config.model.reviewSystemInstructionMode, reasoningMode: config.model.reviewReasoningMode,
    reasoningEffort: config.model.reviewReasoningEffort,
  }, {
    timeoutMs: 60_000, jsonSchema: "auto", maxOutputTokens: 4_096, retryMaxOutputTokens: 8_192,
    contextWindowTokens: null, maxCompletionTokens: null, tokenParameter: "auto", temperatureMode: "auto",
    systemInstructionMode: "system", reasoningMode: "auto", reasoningEffort: null,
  });
});

test("anonymous generator accepts a null credential environment variable", async () => {
  const config = await loadConfig({ overrides: { model: { authMode: "none", apiKeyEnv: null } } });
  assert.deepEqual(publicConfig(config).model.credential, { envVar: null, required: false, configured: false });
  await assert.rejects(loadConfig({ overrides: { model: { authMode: "bearer", apiKeyEnv: null } } }), /unless model.authMode is none/);
});

test("distinct reviewer never inherits generator credentials and uses independent safe compatibility defaults", async () => {
  await assert.rejects(loadConfig({ overrides: { model: { endpoint: "https://generate.example/v1", reviewEndpoint: "https://review.example/v1" } } }), /reviewAuthMode must be explicit/);
  await assert.rejects(loadConfig({ overrides: { model: { endpoint: "https://generate.example/v1", reviewEndpoint: "https://review.example/v1", reviewAuthMode: "bearer" } } }), /reviewApiKeyEnv must be explicit/);

  const config = await loadConfig({ overrides: { model: {
    endpoint: "https://generate.example/v1", model: "shared-name", apiKeyEnv: "GENERATOR_SECRET", authMode: "bearer",
    timeoutMs: 10_000, jsonSchema: "required", reasoningMode: "openrouter", reasoningEffort: "high", sourceEgress: "remote",
    reviewEndpoint: "https://review.example/v1", reviewAuthMode: "none",
  } } });
  assert.equal(config.model.reviewApiKeyEnv, null);
  assert.equal(config.model.reviewAuthMode, "none");
  assert.equal(config.model.reviewModel, "shared-name");
  assert.equal(config.model.reviewTimeoutMs, 60_000);
  assert.equal(config.model.reviewJsonSchema, "auto");
  assert.equal(config.model.reviewReasoningMode, "auto");
  assert.equal(config.model.reviewReasoningEffort, null);
  assert.equal(config.model.reviewSourceEgress, "auto");
  assert.deepEqual(publicConfig(config, { env: { GENERATOR_SECRET: "must-not-be-used-by-reviewer" } }).model.reviewCredential, { envVar: null, required: false, configured: false });
});

test("reviewer-specific validation rejects invalid limits, modes, endpoints, and false local-egress claims", async () => {
  const base = { endpoint: "https://generate.example/v1", reviewEndpoint: "https://review.example/v1", reviewAuthMode: "none" };
  for (const [field, value, pattern] of [
    ["reviewTimeoutMs", 0, /reviewTimeoutMs/], ["reviewJsonSchema", "sometimes", /reviewJsonSchema/],
    ["reviewMaxOutputTokens", 255, /reviewMaxOutputTokens/], ["reviewContextWindowTokens", 511, /reviewContextWindowTokens/],
    ["reviewMaxCompletionTokens", 255, /reviewMaxCompletionTokens/], ["reviewTokenParameter", "max_output_tokens", /reviewTokenParameter/],
    ["reviewTemperatureMode", "sometimes", /reviewTemperatureMode/], ["reviewSystemInstructionMode", "assistant", /reviewSystemInstructionMode/],
    ["reviewReasoningMode", "magic", /reviewReasoningMode/], ["reviewSourceEgress", "maybe", /reviewSourceEgress/],
  ]) await assert.rejects(loadConfig({ overrides: { model: { ...base, [field]: value } } }), pattern);
  await assert.rejects(loadConfig({ overrides: { model: { ...base, reviewMaxOutputTokens: 5_000, reviewRetryMaxOutputTokens: 4_000 } } }), /reviewRetryMaxOutputTokens/);
  await assert.rejects(loadConfig({ overrides: { model: { ...base, reviewSourceEgress: "local" } } }), /reviewSourceEgress=local/);
  await assert.rejects(loadConfig({ overrides: { model: { reviewEndpoint: "http://127.0.0.1:11434/v1?key=secret" } } }), /query/);
});

test("public config reports credential availability without resolving or serializing it", async () => {
  const config = await loadConfig({ overrides: { model: { apiKeyEnv: "PRIVATE_MODEL_KEY" } } });
  const projection = publicConfig(config, { env: { PRIVATE_MODEL_KEY: "do-not-leak" } });
  assert.deepEqual(projection.model.credential, { envVar: "PRIVATE_MODEL_KEY", required: false, configured: true });
  assert.equal(projection.model.maxOutputTokens, 4_096);
  assert.equal(projection.model.retryMaxOutputTokens, 8_192);
  assert.equal(projection.model.contextWindowTokens, null);
  assert.equal(projection.model.maxCompletionTokens, null);
  assert.equal(projection.model.tokenParameter, 'auto');
  assert.equal(projection.model.authMode, 'auto');
  assert.equal(projection.model.sourceEgress, 'auto');
  assert.deepEqual(projection.model.reviewCredential, { envVar: "PRIVATE_MODEL_KEY", required: false, configured: true });
  assert.equal(JSON.stringify(projection).includes("do-not-leak"), false);
  assert.equal("apiKeyEnv" in projection.model, false);
});

test("public config accurately reports independent reviewer credential policy without secrets", async () => {
  const config = await loadConfig({ overrides: { model: {
    endpoint: "https://generate.example/v1", apiKeyEnv: "GENERATOR_KEY", authMode: "bearer",
    reviewEndpoint: "https://review.example/v1", reviewAuthMode: "x-api-key", reviewApiKeyEnv: "REVIEW_KEY",
  } } });
  const projection = publicConfig(config, { env: { GENERATOR_KEY: "generator-secret" } });
  assert.deepEqual(projection.model.credential, { envVar: "GENERATOR_KEY", required: true, configured: true });
  assert.deepEqual(projection.model.reviewCredential, { envVar: "REVIEW_KEY", required: true, configured: false });
  assert.equal(JSON.stringify(projection).includes("generator-secret"), false);
  assert.equal(projection.model.reviewEndpoint, "https://review.example/v1");
  assert.equal(projection.model.reviewReasoningMode, "auto");
  assert.equal(projection.model.reviewSourceEgress, "auto");
});

test("GitHub source configuration requires owner/name", async () => {
  const config = await loadConfig({ overrides: { source: { provider: "github-gh", repository: "owner/repo" } } });
  assert.equal(config.source.repository, "owner/repo");
  await assert.rejects(loadConfig({ overrides: { source: { provider: "github-gh", repository: "invalid" } } }), /owner\/name/);
});

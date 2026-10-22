// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { settingsPaths, settingsSnapshot } from '../settings-store.mjs';
import { OpenAICompatibleModelProvider } from '../providers/model/openai-compatible.mjs';
import { modelCompatibilityCases } from './model-compatibility-cases.mjs';

const selectedIds = process.argv.slice(2);
const selected = selectedIds.length
  ? selectedIds.map((id) => modelCompatibilityCases.find((entry) => entry[1] === id) || ['custom', id])
  : modelCompatibilityCases;
const snapshot = await settingsSnapshot(settingsPaths());
const config = snapshot.config.model;
if (config.provider !== 'openai-compatible' || new URL(config.endpoint).hostname !== 'openrouter.ai') {
  throw new Error('Configure an OpenRouter OpenAI-compatible endpoint in Settings before running the model compatibility smoke test.');
}
const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
let failures = 0;
for (const [family, model] of selected) {
  const provider = new OpenAICompatibleModelProvider({
    endpoint: config.endpoint, model, apiKeyEnv: config.apiKeyEnv, authMode: config.authMode,
    jsonSchema: config.jsonSchema, tokenParameter: config.tokenParameter,
    temperatureMode: config.temperatureMode, systemInstructionMode: config.systemInstructionMode,
    reasoningEffort: config.reasoningEffort, reasoningRequestMode: config.reasoningMode,
    timeoutMs: Math.min(config.timeoutMs, 30_000), env: snapshot.env,
  });
  try {
    const result = await provider.completeJson({
      messages: [{ role: 'system', content: 'Return one JSON object with ok set to true.' }, { role: 'user', content: 'Set ok to true.' }],
      schema, schemaName: 'compatibility_smoke', maxTokens: Math.min(Math.max(config.maxOutputTokens, 1_024), 4_096), timeoutMs: 30_000,
    });
    if (result.value?.ok !== true) throw Object.assign(new Error('The model returned JSON without ok=true.'), { code: 'model_output_schema_violation' });
    console.log(JSON.stringify({ family, model, status: 'ok', structured_output: result.structuredOutputMode, token_parameter: result.tokenParameter, reasoning_mode: result.reasoningRequestMode }));
  } catch (error) {
    failures += 1;
    const action = {
      model_provider_age_confirmation_required: 'Complete age confirmation in OpenRouter Settings → Preferences.',
      model_provider_access_restricted: 'Choose a model available to this app; this free endpoint is limited to approved agentic harnesses.',
      model_output_truncated: 'Increase the output token limit in Settings.',
    }[error.code] || null;
    console.log(JSON.stringify({ family, model, status: 'failed', code: error.code || 'unknown', http_status: error.status || null, provider_code: error.providerCode || null, action }));
  }
}
console.log(`${selected.length - failures}/${selected.length} model families returned usable JSON.`);
if (failures) process.exitCode = 1;

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
// Public provider model IDs for the opt-in compatibility smoke command.
// Callers must confirm current access; deterministic tests verify request shapes with fakes.
export const modelCompatibilityCases = [
  ['OpenAI', 'openai/gpt-6-luna', ['max_completion_tokens', 'max_tokens', 'reasoning', 'reasoning_effort', 'response_format']],
  ['Anthropic', 'anthropic/claude-sonnet-4.5', ['max_completion_tokens', 'max_tokens', 'reasoning', 'response_format', 'temperature']],
  ['Gemini', 'google/gemini-3.5-flash', ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'temperature']],
  ['Z.ai', 'z-ai/glm-5.3-flash', ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'temperature']],
  ['Grok', 'x-ai/grok-4.3', ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'temperature']],
  ['Qwen', 'qwen/qwen3.5-plus-20260420', ['max_tokens', 'reasoning', 'response_format', 'temperature']],
  ['DeepSeek', 'deepseek/deepseek-v4.1-flash', ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'temperature']],
  ['Muse', 'meta/muse-spark-1.3', ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'temperature']],
  ['Mistral', 'mistralai/mistral-medium-3-5', ['max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'temperature']],
  ['Inkling', 'thinkingmachines/inkling-small', ['max_tokens', 'reasoning', 'reasoning_effort', 'temperature']],
];

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // Contributor-guide symlinks are not mutation inputs and cannot be copied as files on macOS.
  ignorePatterns: ['.agents/**', '.claude/**'],
  mutate: [
    'question-lifecycle.mjs:39-111',
    'ui-logic.mjs:3-55',
    'ui-logic.mjs:109-131',
    'ui-logic.mjs:173-189',
    'providers/model/openai-compatible.mjs:7-15',
    'providers/model/openai-compatible.mjs:39-55',
    'providers/model/openai-compatible.mjs:66-80',
    'providers/model/openai-compatible.mjs:83-104',
  ],
  mutator: { excludedMutations: ['StringLiteral', 'ObjectLiteral', 'OptionalChaining', 'ArrowFunction', 'MethodExpression', 'ArrayDeclaration'] },
  testRunner: 'command',
  commandRunner: { command: 'node --import ./scripts/test-safety.mjs --test question-lifecycle.test.mjs ui-logic.test.mjs providers.test.mjs' },
  coverageAnalysis: 'off',
  concurrency: 4,
  timeoutMS: 10_000,
  reporters: ['clear-text', 'progress'],
  thresholds: { high: 80, low: 65, break: 65 },
  cleanTempDir: 'always',
};

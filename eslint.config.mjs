// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'reports/**', 'coverage/**', 'test-results/**', 'playwright-report/**', '.stryker-tmp/**', 'fixtures/**'] },
  js.configs.recommended,
  // This transport strips ASCII control characters from provider error text.
  { files: ['providers/model/openai-compatible.mjs'], rules: { 'no-control-regex': 'off' } },
  { files: ['**/*.mjs'], languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node, ...globals.browser } }, rules: {
    'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  } },
];

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  timeout: 30_000,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4199', trace: 'retain-on-failure' },
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:4199',
    env: { ...process.env, HOST: '127.0.0.1', PORT: '4199' },
    reuseExistingServer: false,
    timeout: 20_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});

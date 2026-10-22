// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
// Preloaded by offline tests before modules can discover a real user profile.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

// Keep the browser executable cache stable while isolating credential stores.
process.env.PLAYWRIGHT_BROWSERS_PATH ||= process.platform === 'win32' ? join(tmpdir(), 'codebase-trail-playwright') : '/tmp/codebase-trail-playwright';
const home = mkdtempSync(join(tmpdir(), 'codebase-trail-test-home-'));
const bin = join(home, 'bin');
mkdirSync(bin);
for (const name of ['gh', 'claude', 'codex']) {
  const body = '#!/bin/sh\n# Offline tests must inject their own helper instead of using a signed-in CLI.\nexit 1\n';
  writeFileSync(join(bin, name), body, { mode: 0o755 });
  writeFileSync(join(bin, `${name}.cmd`), '@echo off\r\nexit /b 1\r\n');
}
for (const name of Object.keys(process.env)) {
  if (/^(?:CODE_LEARNING_|CODEBASE_TRAIL_|OPENAI_|ANTHROPIC_|GOOGLE_CLOUD_ACCESS_TOKEN$|GH_TOKEN$|GITHUB_TOKEN$|LLM_)/.test(name)) delete process.env[name];
}
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
  XDG_CONFIG_HOME: home, GH_CONFIG_DIR: join(home, 'gh'), CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude'),
  CODE_LEARNING_HOME: join(home, 'settings'), CODE_LEARNING_STORE_PATH: join(home, 'history.json'),
  CODE_LEARNING_CACHE_DIR: join(home, 'cache'), PATH: `${bin}${delimiter}${process.env.PATH || ''}`,
});
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`Offline test blocked external request to ${url.hostname}`);
  return originalFetch(input, options);
};
process.once('exit', () => rmSync(home, { recursive: true, force: true }));

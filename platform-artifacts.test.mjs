// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);

test('locked language packages ship Windows x64 prebuilds and require x64 Node on Windows ARM64', () => {
  const lock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url), 'utf8'));
  for (const language of ['go', 'python', 'java', 'kotlin', 'rust', 'ruby', 'csharp']) {
    const name = `@ast-grep/lang-${language}`;
    const root = dirname(require.resolve(`${name}/package.json`));
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.version, lock.packages[`node_modules/${name}`].version);
    assert.ok(manifest.files.includes('prebuilds'));
    assert.ok(existsSync(join(root, 'prebuilds', 'prebuild-Windows-X64', 'parser.so')), name);
    assert.equal(existsSync(join(root, 'prebuilds', 'prebuild-Windows-ARM64', 'parser.so')), false, name);
  }
});

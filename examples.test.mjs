// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('README contributor example runs the same boundary example as the examples index', async () => {
  const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8');
  const example = await readFile(new URL('./examples/practice-a-boundary/README.md', import.meta.url), 'utf8');
  const quickstart = readme.split('## For contributors\n')[1].split('\n## ')[0];
  assert.ok(quickstart.includes(example.match(/```sh\n([\s\S]*?)\n```/)[1]));
  assert.ok(quickstart.includes(example.match(/```text\n([\s\S]*?)\n```/)[1]));
});

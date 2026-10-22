// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const directories = (await readdir(new URL('../examples/', import.meta.url), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const index = await readFile(new URL('../examples/README.md', import.meta.url), 'utf8');
const indexed = [...index.matchAll(/\]\(([a-z-]+)\/\)/g)].map((match) => match[1]).sort();
assert.deepEqual(indexed, directories, 'Examples index must list every folder once.');
for (const directory of directories) {
  const readme = await readFile(new URL(`../examples/${directory}/README.md`, import.meta.url), 'utf8');
  const commands = [...readme.matchAll(/```sh\n([\s\S]*?)\n```/g)];
  const outputs = [...readme.matchAll(/```text\n([\s\S]*?)\n```/g)];
  assert.equal(commands.length, 1); assert.equal(outputs.length, 1);
  const command = commands[0][1];
  // Parse the deliberately small example command vocabulary without a shell.
  assert.match(command, /^node examples\/[a-z-]+\/main\.mjs$/);
  const args = command.split(' ').slice(1);
  const { stdout } = await run(process.execPath, args, { cwd: root, timeout: 60_000, env: process.env });
  assert.equal(stdout, `${outputs[0][1]}\n`, `${directory} output must match its README.`);
  console.log(`${directory}: output matches`);
}

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertCoverageReport } from './coverage-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = readdirSync(root).filter((name) => name.endsWith('.test.mjs')).sort();
// The launcher reloads server.mjs with unique import URLs as settings change.
// Node's coverage report treats those copies as one file without merging hits.
const isolatedTests = ['launcher.test.mjs', 'ipv6-loopback.test.mjs'];
const coverageTests = tests.filter((name) => !isolatedTests.includes(name));
const child = spawn(process.execPath, [
  '--import', './scripts/test-safety.mjs',
  '--experimental-test-coverage',
  '--test', ...coverageTests,
], { cwd: root, stdio: ['inherit', 'pipe', 'pipe'] });

let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text); });
const exitCode = await new Promise((resolve) => child.on('close', resolve));
if (exitCode !== 0) process.exit(exitCode || 1);

// Enforce the same thresholds on Node 20, which lacks the threshold CLI flags.
assertCoverageReport(output);

const isolated = spawn(process.execPath, ['--import', './scripts/test-safety.mjs', '--test', ...isolatedTests], { cwd: root, stdio: 'inherit' });
const isolatedExitCode = await new Promise((resolve) => isolated.on('close', resolve));
if (isolatedExitCode !== 0) process.exit(isolatedExitCode || 1);

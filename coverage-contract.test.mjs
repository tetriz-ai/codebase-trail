// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCoverageReport } from './scripts/coverage-contract.mjs';

const report = (overall = [90, 75, 90], server = [78, 75, 85]) => `# all files | ${overall.join(' | ')} |\n# server.mjs | ${server.join(' | ')} |`;

test('coverage accepts the exact aggregate and server thresholds', () => {
  assert.doesNotThrow(() => assertCoverageReport(report()));
  assert.doesNotThrow(() => assertCoverageReport(report().replaceAll('#', 'ℹ')));
  assert.doesNotThrow(() => assertCoverageReport(report([100, 100, 100], [100, 100, 100])));
});

test('coverage rejects each aggregate and server metric below its threshold', () => {
  for (const [scope, minimum] of [['all files', [90, 75, 90]], ['server.mjs', [78, 75, 85]]]) {
    for (let index = 0; index < 3; index += 1) {
      const lowered = [...minimum];
      lowered[index] -= 0.01;
      const output = scope === 'all files' ? report(lowered) : report(undefined, lowered);
      assert.throws(() => assertCoverageReport(output), new RegExp(`${scope.replace('.', '\\.')} coverage regressed`));
    }
  }
});

test('coverage rejects missing or malformed report rows', () => {
  assert.throws(() => assertCoverageReport(''), /could not find/);
  assert.throws(() => assertCoverageReport('# all files | invalid | 100 | 100 |'), /Invalid all files/);
  assert.throws(() => assertCoverageReport('# all files | 100 | 100 | 100 |'), /server.mjs/);
});

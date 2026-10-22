// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT

const thresholds = [
  ['all files', { lines: 90, branches: 75, functions: 90 }],
  ['server.mjs', { lines: 78, branches: 75, functions: 85 }],
];

export function assertCoverageReport(output) {
  for (const [label, minimum] of thresholds) {
    const row = output.split('\n').find((line) => line.split('|')[0].replace(/^[#ℹ]\s*/, '').trim() === label);
    if (!row) throw new Error(`Coverage gate could not find the ${label} coverage row.`);
    const values = row.split('|').slice(1, 4).map((cell) => Number(cell.trim()));
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) throw new Error(`Invalid ${label} coverage row.`);
    const failures = Object.keys(minimum).flatMap((name, index) => values[index] < minimum[name] ? [`${name} ${values[index]}% < ${minimum[name]}%`] : []);
    if (failures.length) throw new Error(`${label} coverage regressed: ${failures.join(', ')}`);
  }
}

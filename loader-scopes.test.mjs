// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceImportEntries } from './syntax-analysis.mjs';

for (const extension of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']) {
  test(`require bindings affect only their lexical scope in ${extension}`, () => {
    for (const declaration of [
      'const unrelated = (require) => require;',
      'function unrelated(require) { require("./shadow.js"); }',
      'function unrelated() { var require; require("./shadow.js"); }',
      '{ const require = loader; require("./shadow.js"); }',
      'for (const require of loaders) { require("./shadow.js"); }',
      'try {} catch ({ loader: require }) { require("./shadow.js"); }',
      'const C = class require { method() { require("./shadow.js"); } };',
      'const f = function require() { require("./shadow.js"); };',
      String.raw`function unrelated(requ\u0069re) { require("./shadow.js"); }`,
    ]) {
      const result = sourceImportEntries(`scope.${extension}`, `${declaration}\nrequire("./outer.js");`);
      assert.deepEqual(result.errors, [], declaration);
      assert.deepEqual(result.entries.map(({ spec }) => spec), ['./outer.js'], declaration);
    }
  });
}

test('hoisting, destructuring, defaults and loop bindings preserve loader resolution', () => {
  for (const source of [
    'require("./shadow.js"); var require;',
    'require("./shadow.js"); function require() {}',
    '{ require("./shadow.js"); let require; }',
    'function f() { require("./shadow.js"); { var require; } }',
    'function f() { { function require(value) { return value; } } require("./shadow.js"); }',
    'function f({ loader: require } = source) { require("./shadow.js"); }',
    'function f(require = loader, value = require("./shadow.js")) {}',
    'for (let require = loader; require("./shadow.js");) {}',
    'for (var require of loaders) {} require("./shadow.js");',
    'import { loader as require } from "external"; require("./shadow.js");',
    'enum require { value }; require("./shadow.js");',
    'namespace require { export const value = 1; }; require("./shadow.js");',
  ]) assert.ok(!sourceImportEntries('scope.ts', source).entries.some(({ spec }) => spec === './shadow.js'), source);
  for (const source of [
    'function f(value = require("./outer.js")) { var require; }',
    '{ enum require { value } } require("./outer.js");',
    'type require = string; interface Other { require: string }; require("./outer.js");',
    'const { require: other } = source; require("./outer.js");',
  ]) assert.deepEqual(sourceImportEntries('scope.ts', source).entries.map(({ spec }) => spec), ['./outer.js'], source);
  for (const declaration of ['import type require from "external";', 'import { type require } from "external";']) {
    assert.ok(sourceImportEntries('scope.ts', `${declaration} require("./outer.js");`).entries.some(({ spec }) => spec === './outer.js'));
  }
});

test('many disjoint and nested bindings preserve every outer dependency', () => {
  const source = Array.from({ length: 500 }, (_, index) => `function scope${index}(require) { { const require = loader; require("./shadow.js"); } } require("./outer${index}.js");`).join('\n');
  const result = sourceImportEntries('large.js', source);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.entries.map(({ spec }) => spec), Array.from({ length: 500 }, (_, index) => `./outer${index}.js`));
});

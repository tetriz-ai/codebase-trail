// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { javascriptImportedBindings, javascriptRouteHandlers, sourceImportEntries } from './syntax-analysis.mjs';

test('extracts imports from JavaScript, Go, and Python syntax trees', () => {
  assert.deepEqual(sourceImportEntries('app.ts', `// import ghost from './ghost'\nimport x from './real'; const y = require('./required')`).entries.map(({ spec }) => spec), ['./real', './required']);
  assert.deepEqual(sourceImportEntries('main.go', 'package main\nvar docs = `"fake/path"`\nimport alias "example.com/real"').entries.map(({ spec }) => spec), ['example.com/real']);
  assert.deepEqual(sourceImportEntries('main.py', 'text = "import fake"\nfrom .worker import run\nimport pkg.jobs as jobs').entries.map(({ spec }) => spec), ['.worker', 'pkg.jobs']);
  assert.deepEqual(sourceImportEntries('pkg/sub/main.py', 'from . import sibling\nfrom .. import common').entries.map(({ spec }) => spec), ['.sibling', '..common']);
});

test('supports TypeScript module extensions and only reads explicit export sources', () => {
  for (const extension of ['mts', 'cts']) assert.deepEqual(sourceImportEntries(`app.${extension}`, "import x from './real'").entries.map(({ spec }) => spec), ['./real']);
  assert.deepEqual(sourceImportEntries('app.ts', "export function f(){ return './ghost' }\nexport { x } from './real'").entries.map(({ spec }) => spec), ['./real']);
});

test('extracts imported route-handler bindings from real call expressions only', () => {
  const content = `import { handler as run } from './handler';\n// router.get('/fake', run)\nrouter.get('/real', auth, run);\nrouter.route('/chained').post(run);`;
  assert.equal(javascriptImportedBindings(content).bindings.get('run'), './handler');
  assert.deepEqual(javascriptRouteHandlers(content).handlers.map(({ binding }) => binding), ['run', 'run']);
});

test('surfaces syntax errors so graph extraction can fail closed', () => {
  assert.ok(sourceImportEntries('broken.ts', 'import {').errors.length > 0);
  assert.ok(sourceImportEntries('broken.py', 'from . import').errors.length > 0);
  assert.ok(sourceImportEntries('missing-token.py', 'def f(:\n pass').errors.some(({ kind }) => kind === 'missing_token'));
});

test('does not misclassify valid zero-width nodes or known TypeScript grammar artifacts', () => {
  assert.deepEqual(sourceImportEntries('empty.go', 'package empty\nvar value = ``\n').errors, []);
  assert.deepEqual(sourceImportEntries('component.tsx', 'type T = import("./types").Thing;\nconst view = <button>Save & continue</button>;').errors, []);
  assert.deepEqual(sourceImportEntries('query.tsx', 'const view = <a href="?tab=x&itab=y">Open</a>;').errors, []);
});

test('expands grouped Rust use declarations without losing their prefix', () => {
  assert.deepEqual(sourceImportEntries('lib.rs', 'use crate::{a::B, c};').entries.map(({ spec }) => spec), ['crate::a::B', 'crate::c']);
});

test('computed and shadowed loader calls cannot prove imports', () => {
  for (const callee of ['import', 'require']) {
    for (const argument of ['"./worker/b.js" + ".missing"', 'transform("./worker/b.js")', 'enabled ? "./worker/b.js" : "./other.js"']) {
      assert.deepEqual(sourceImportEntries('a.js', `const dep = ${callee}(${argument});`).entries, [], `${callee}(${argument})`);
    }
    assert.deepEqual(sourceImportEntries('a.js', `// fixture\nconst dep = ${callee}(/* comment */ "./worker/b.js");`).entries, [{ spec: './worker/b.js', line: 2 }]);
  }
  for (const content of [
    'function require(x) { return x; } require("./worker/b.js");',
    'const require = (x) => x; require("./worker/b.js");',
    'function f(require) { return require("./worker/b.js"); }',
    'const f = require => require("./worker/b.js");',
    'const { loader: require } = source; require("./worker/b.js");',
    'const { require } = source; require("./worker/b.js");',
    'try {} catch (require) { require("./worker/b.js"); }',
    'import { loader as require } from "external"; require("./worker/b.js");',
    'import require from "external"; require("./worker/b.js");',
  ]) assert.ok(!sourceImportEntries('a.js', content).entries.some(({ spec }) => spec === './worker/b.js'), content);
  for (const content of [
    'import require = loader; require("./worker/b.js");',
    'import require = require("external"); require("./worker/b.js");',
    'const f = (require?: Loader) => require("./worker/b.js");',
    'function f({ require }: Loaders) { require("./worker/b.js"); }',
  ]) assert.ok(!sourceImportEntries('a.ts', content).entries.some(({ spec }) => spec === './worker/b.js'), content);
  assert.deepEqual(sourceImportEntries('a.js', 'const object = { require: 1 }; const { require: other } = object; require("./worker/b.js");').entries, [{ spec: './worker/b.js', line: 1 }]);
  assert.deepEqual(sourceImportEntries('a.ts', 'import x from "./static.js";\nexport { x } from "./export.js";\nimport("./dynamic.js");').entries, [{ spec: './static.js', line: 1 }, { spec: './export.js', line: 2 }, { spec: './dynamic.js', line: 3 }]);
});

test('loop and Unicode-escaped bindings suppress only locally named require loaders', () => {
  for (const file of ['a.js', 'a.ts']) {
    for (const content of [
      'for (const require of [x => x]) { require("./worker/b.js"); }',
      'for (let require in values) { require("./worker/b.js"); }',
      'for (var { loader: require } of values) { require("./worker/b.js"); }',
      'for (const [require] of values) { require("./worker/b.js"); }',
      String.raw`const requ\u0069re = x => x; require("./worker/b.js");`,
      String.raw`function f(requ\u{69}re) { require("./worker/b.js"); }`,
      String.raw`const { requ\u0069re } = source; require("./worker/b.js");`,
      String.raw`import { loader as requ\u{69}re } from "external"; require("./worker/b.js");`,
    ]) {
      const parsed = sourceImportEntries(file, content);
      assert.deepEqual(parsed.errors, [], content);
      assert.ok(!parsed.entries.some(({ spec }) => spec === './worker/b.js'), content);
    }
    const harmless = String.raw`for (const { requ\u0069re: other } of values) {}\nrequire("./worker/b.js");`.replace('\\n', '\n');
    assert.deepEqual(sourceImportEntries(file, harmless).entries, [{ spec: './worker/b.js', line: 2 }]);
  }
  for (const content of [
    String.raw`import requ\u0069re = loader; require("./worker/b.js");`,
    String.raw`import requ\u{69}re = require("external"); require("./worker/b.js");`,
  ]) assert.ok(!sourceImportEntries('a.ts', content).entries.some(({ spec }) => spec === './worker/b.js'), content);
});

test('runtime declarations suppress local require across supported JavaScript and TypeScript extensions', () => {
  for (const extension of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']) {
    for (const declaration of ['class require {}', String.raw`class requ\u0069re {}`]) {
      assert.deepEqual(sourceImportEntries(`a.${extension}`, `${declaration}\nrequire("./worker/b.js");`).entries, [], `${extension}: ${declaration}`);
    }
  }
  for (const declaration of ['enum require { value }', 'namespace require { export const value = 1; }', String.raw`namespace requ\u{69}re { export const value = 1; }`]) {
    const result = sourceImportEntries('a.ts', `${declaration}\nrequire("./worker/b.js");`);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.entries, [], declaration);
  }
  assert.deepEqual(sourceImportEntries('a.ts', 'type require = string; interface Other { require: string }; require("./worker/b.js");').entries, [{ spec: './worker/b.js', line: 1 }]);
});

test('escaped JavaScript module literals decode without evaluating expressions', () => {
  for (const literal of [String.raw`"./worker/\u0062.js"`, String.raw`'./worker/\u{62}.js'`, String.raw`"./worker/\x62.js"`, String.raw`".\/worker/b.js"`, '"./worker/\\\nb.js"']) {
    for (const source of [`import x from ${literal};`, `export { x } from ${literal};`, `import(${literal});`, `require(${literal});`]) {
      assert.deepEqual(sourceImportEntries('a.js', source).entries, [{ spec: './worker/b.js', line: 1 }], source);
    }
  }
  assert.deepEqual(sourceImportEntries('a.js', String.raw`require("./worker/\u0062.js" + ".missing");`).entries, []);
});

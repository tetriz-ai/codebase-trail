// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepositoryModuleIndex, resolveCsharpModule, resolveJavaFamilyModule, resolveNodeModule, resolvePythonModule, resolveRubyModule, resolveRustModule } from './module-resolution.mjs';

test('resolves every supported Node module extension through one shared policy', () => {
  const index = createRepositoryModuleIndex(['src/app.ts', 'src/worker.mts', 'src/legacy.cts', 'src/runtime.cjs']);
  assert.equal(resolveNodeModule(index, 'src/app.ts', './worker'), 'src/worker.mts');
  assert.equal(resolveNodeModule(index, 'src/app.ts', './legacy'), 'src/legacy.cts');
  assert.equal(resolveNodeModule(index, 'src/app.ts', './runtime'), 'src/runtime.cjs');
});

test('resolves uniquely owned Java-family, Ruby, and Rust modules', () => {
  const index = createRepositoryModuleIndex(['src/main/java/com/acme/Worker.java', 'lib/jobs.rb', 'src/worker.rs']);
  assert.equal(resolveJavaFamilyModule(index, 'com.acme.Worker', ['.java']), 'src/main/java/com/acme/Worker.java');
  assert.equal(resolveRubyModule(index, 'lib/app.rb', './jobs'), 'lib/jobs.rb');
  assert.equal(resolveRustModule(index, 'src/lib.rs', 'crate::worker::run'), 'src/worker.rs');
});

test('resolves Rust crate, self, and repeated super paths from the declaring module', () => {
  const index = createRepositoryModuleIndex(['Cargo.toml', 'src/root.rs', 'src/foo/bar.rs', 'src/foo/bar/baz.rs', 'src/foo/shared.rs', 'src/shared.rs']);
  assert.equal(resolveRustModule(index, 'src/foo/bar.rs', 'crate::shared::value'), 'src/shared.rs');
  assert.equal(resolveRustModule(index, 'src/foo/bar.rs', 'self::baz::value'), 'src/foo/bar/baz.rs');
  assert.equal(resolveRustModule(index, 'src/foo/bar.rs', 'super::shared::value'), 'src/foo/shared.rs');
  assert.equal(resolveRustModule(index, 'src/foo/deep/bar.rs', 'super::super::super::shared::value'), 'src/shared.rs');
});

test('resolves workspace packages, nested Cargo crates, and unambiguous C# namespaces', () => {
  const index = createRepositoryModuleIndex([
    { path: 'packages/ui/package.json', content: '{"name":"@acme/ui"}' },
    'packages/ui/index.ts',
    { path: 'crates/jobs/Cargo.toml', content: '[package]\nname="jobs"' },
    'crates/jobs/src/lib.rs', 'crates/jobs/src/worker.rs',
    { path: 'src/Jobs/Worker.cs', content: 'namespace Acme.Jobs; class Worker {}' },
  ]);
  assert.equal(resolveNodeModule(index, 'apps/web/app.ts', '@acme/ui'), 'packages/ui/package.json');
  assert.equal(resolveNodeModule(index, 'apps/web/app.ts', '@acme/ui/does-not-exist'), null);
  assert.equal(resolveRustModule(index, 'crates/jobs/src/lib.rs', 'crate::worker::run'), 'crates/jobs/src/worker.rs');
  assert.equal(resolveCsharpModule(index, 'Acme.Jobs'), 'src/Jobs/Worker.cs');
});

test('indexes Python modules once and keeps ambiguous absolute imports unresolved', () => {
  const unique = createRepositoryModuleIndex(['service/pkg/jobs.py']);
  assert.equal(resolvePythonModule(unique, 'service/app.py', 'pkg.jobs'), 'service/pkg/jobs.py');
  const ambiguous = createRepositoryModuleIndex(['one/pkg/jobs.py', 'two/pkg/jobs.py']);
  assert.equal(resolvePythonModule(ambiguous, 'one/app.py', 'pkg.jobs'), null);
});

test('resolves Python relative imports, packages, and ambiguity without escaping the repository', () => {
  const index = createRepositoryModuleIndex([
    'pkg/__init__.py', 'pkg/common.py', 'pkg/sub/__init__.py', 'pkg/sub/worker.py', 'pkg/sub/sibling.py',
    'pkg/sub/tasks.py', 'pkg/sub/tasks/__init__.py', 'outside.py',
  ]);
  assert.equal(resolvePythonModule(index, 'pkg/sub/worker.py', '.sibling'), 'pkg/sub/sibling.py');
  assert.equal(resolvePythonModule(index, 'pkg/sub/worker.py', '..common'), 'pkg/common.py');
  assert.equal(resolvePythonModule(index, 'pkg/worker.py', '.sub'), 'pkg/sub/__init__.py');
  assert.equal(resolvePythonModule(index, 'pkg/sub/worker.py', '.tasks'), null, 'module/package collisions fail closed');
  assert.equal(resolvePythonModule(index, 'pkg/worker.py', '...outside'), null);
});

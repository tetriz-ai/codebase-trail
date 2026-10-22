// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_STACK_PLUGINS, createExtractorRegistry, createServiceBoundaryConventionPlugin, extractArchitectureGraph, recognizedArchitecturePath, resolveServiceIdentities, toOrgInventory } from './architecture-extractors.mjs';
import { buildEvidencePack, buildOrgGraph } from './org-graph.mjs';

const repo = (files, extra = {}) => ({ repository_id: 'example-org/app', revision: 'abc123', tree_complete: true, files: files.map(([path, content]) => ({ path, content, complete: true })), ...extra });

test('registers a language-neutral built-in extractor plugin set', () => {
  const registry = createExtractorRegistry();
  assert.deepEqual(registry.plugins.map(({ id }) => id), ['go', 'typescript-javascript', 'python', 'java', 'kotlin', 'rust', 'ruby', 'csharp', 'workspace-manifests', 'protobuf', 'sql', 'kubernetes-helm', 'compose', 'terraform']);
  assert.ok(registry.manifest.every(({ api_version, capabilities }) => api_version === '1.0' && Array.isArray(capabilities.languages)));
  assert.throws(() => createExtractorRegistry([CORE_STACK_PLUGINS[0], CORE_STACK_PLUGINS[0]]), /Duplicate/);
});

test('extracts discoveries and raw typed claims for the supported language set', () => {
  const graph = extractArchitectureGraph({ repositories: [repo([
    ['go.mod', 'module github.com/example-org/app'], ['backend/api/main.go', 'package api\nimport "github.com/example-org/app/worker"'],
    ['client/package.json', '{"name":"@example/client"}'], ['client/app.ts', "import x from './x'"],
    ['automation/pyproject.toml', '[project]\nname = "automation"'], ['automation/main.py', 'from worker.jobs import run'],
    ['proto/task.proto', 'syntax = "proto3";\nimport "common.proto";\nservice TaskService {\n rpc Run(Task) returns (Task);\n}'],
    ['migrations/1.sql', 'CREATE TABLE jobs(id int);\nALTER TABLE runs ADD FOREIGN KEY(job_id) REFERENCES jobs(id);'],
    ['deploy/k8s/api.yaml', 'kind: Deployment\nmetadata:\n  name: api'],
    ['deploy/docker-compose.yml', 'services:\n  api:\n    depends_on:\n      - db\n  db:\n    image: postgres'],
    ['infra/main.tf', 'resource "aws_sqs_queue" "jobs" {}\noutput "id" { value = module.worker.id }'],
  ])] });
  assert.equal(graph.completeness, 'complete');
  assert.ok(graph.discoveries.some((entry) => entry.kind === 'service_contract' && entry.name === 'TaskService'));
  assert.ok(graph.discoveries.some((entry) => entry.kind === 'datastore_resource' && entry.name === 'jobs'));
  assert.ok(graph.discoveries.some((entry) => entry.kind === 'infrastructure_resource'));
  assert.ok(graph.claims.some((entry) => entry.resolver === 'go_import'));
  assert.ok(graph.claims.some((entry) => entry.claim_kind === 'depends_on' && entry.provenance === 'deployment_declared'));
  assert.ok(graph.claims.every((entry) => entry.resolution_state === 'unresolved' && entry.quiz_eligible === false));
  assert.ok(graph.claims.every((entry) => entry.evidence[0].content_hash.length === 64));
});

test('resolves service identity by explicit precedence and fails ambiguity closed', () => {
  const values = [{ repository_id: 'r', candidate_name: 'module-name', source: 'language_detector', precedence: 1 }, { repository_id: 'r', candidate_name: 'deployed-name', source: 'deployment_declaration', precedence: 2 }];
  assert.deepEqual(resolveServiceIdentities(values)[0], { repository_id: 'r', service_name: 'deployed-name', identity_source: 'deployment_declaration', resolution_state: 'resolved', candidates: [values[1]] });
  const overridden = resolveServiceIdentities(values, [{ repository_id: 'r', candidate_name: 'canonical' }])[0];
  assert.equal(overridden.service_name, 'canonical'); assert.equal(overridden.identity_source, 'maintainer_override');
  assert.equal(resolveServiceIdentities([{ ...values[1] }, { ...values[1], candidate_name: 'other' }])[0].resolution_state, 'ambiguous');
});

test('marks incomplete trees and required blobs incomplete and emits diagnostics', () => {
  const graph = extractArchitectureGraph({ repositories: [{ repository_id: 'r', revision: '1', tree_complete: false, files: [{ path: 'main.go', truncated: true, content: 'package main' }] }] });
  assert.equal(graph.completeness, 'incomplete');
  assert.deepEqual(graph.diagnostics.map(({ code }) => code), ['repository_tree_incomplete', 'required_blob_incomplete']);
});

test('plugin parse diagnostics fail extraction and organization inventory closed', () => {
  const malformed = repo([['client/package.json', '{"name":']]);
  const extraction = extractArchitectureGraph({ repositories: [malformed] });
  assert.equal(extraction.completeness, 'incomplete');
  assert.ok(extraction.diagnostics.some(({ plugin, code, repository_id }) => plugin === 'typescript-javascript' && code === 'invalid_manifest' && repository_id === malformed.repository_id));
  const inventory = toOrgInventory(malformed, extraction);
  assert.equal(inventory.complete, false);
  assert.ok(inventory.diagnostics.some(({ code }) => code === 'invalid_manifest'));
  assert.equal(buildOrgGraph({ inventories: [inventory] }).complete, false);
});

test('source syntax errors abstain for that file without invalidating unrelated AST evidence', () => {
  const repository = repo([
    ['broken/package.json', '{"name":"broken"}'], ['broken/broken.ts', 'import {'],
    ['valid/package.json', '{"name":"valid"}'], ['valid/valid.ts', "import value from './value';"], ['valid/value.ts', 'export default 1;'],
  ]);
  const extraction = extractArchitectureGraph({ repositories: [repository] });
  assert.equal(extraction.completeness, 'complete');
  assert.ok(extraction.diagnostics.some(({ plugin, code, blocking }) => plugin === 'typescript-javascript' && code === 'source_parse_error' && blocking === false));
  assert.ok(!extraction.claims.some(({ evidence }) => evidence.some(({ path }) => path === 'broken/broken.ts')));
  assert.ok(extraction.claims.some(({ evidence }) => evidence.some(({ path }) => path === 'valid/valid.ts')));
  const graph = buildOrgGraph({ inventories: [toOrgInventory(repository, extraction)] });
  assert.ok(graph.incompleteBoundaryIds.some((id) => id.includes('project:npm:broken')));
  assert.equal(buildEvidencePack(graph, { scope: 'lld' }).eligible, true);
  assert.ok(buildEvidencePack(graph, { scope: 'lld' }).claims.every(({ evidence }) => evidence.every(({ path }) => !path.startsWith('broken/'))));
});

test('Kubernetes extraction ignores nested keys and Compose-shaped files', () => {
  const repository = repo([
    ['deploy/k8s/api.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    metadata:\n      name: pod-name\n    spec:\n      volumes:\n        - name: cache'],
    ['deploy/k8s/broken.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  labels:\n    app: broken'],
  ]);
  const extraction = extractArchitectureGraph({ repositories: [repository] });
  assert.deepEqual(extraction.discoveries.filter(({ kind }) => kind === 'deployment').map(({ name }) => name), ['api']);
  assert.ok(!extraction.discoveries.some(({ name }) => ['pod-name', 'cache', 'volumes'].includes(name)));
  assert.equal(extraction.completeness, 'incomplete');
  assert.ok(extraction.diagnostics.some(({ plugin, code }) => plugin === 'kubernetes-helm' && code === 'resource_name_unresolved'));
  assert.ok(toOrgInventory(repository, extraction).services.some(({ id }) => id === 'api'));
});

test('Compose retains multiple services, resolves dependencies, and ignores volumes and nested keys', () => {
  const repository = repo([['deploy/docker-compose.yml', `services:
  api:
    image: acme/api
    depends_on:
      db:
        condition: service_healthy
      cache: {}
    volumes:
      - api-data:/data
  db:
    image: postgres
  cache:
    image: redis
volumes:
  api-data:
networks:
  default:
`]]);
  const extraction = extractArchitectureGraph({ repositories: [repository] });
  const inventory = toOrgInventory(repository, extraction);
  assert.equal(extraction.completeness, 'complete');
  assert.deepEqual(inventory.services.map(({ id }) => id).sort(), ['api', 'cache', 'db']);
  assert.ok(!inventory.services.some(({ id }) => ['api-data', 'condition', 'default', 'volumes'].includes(id)));
  assert.deepEqual(inventory.dependencies.map(({ source, target }) => [source, target]), [['api', 'db'], ['api', 'cache']]);
  const graph = buildOrgGraph({ inventories: [inventory] });
  assert.equal(graph.complete, true);
  assert.ok(graph.edges.every(({ resolution, quizEligible }) => resolution === 'resolved' && quizEligible));
});

test('recognizes source, deployment, and manifest paths', () => {
  for (const path of ['main.go', 'web/app.tsx', 'worker.py', 'Main.java', 'App.kt', 'lib.rs', 'worker.rb', 'Program.cs', 'api.proto', 'schema.sql', 'main.tf', 'deploy/k8s/api.yaml', 'docker-compose.yml', 'go.mod', 'package.json', 'Cargo.toml', 'pom.xml', 'build.gradle.kts', 'App.csproj', 'App.sln']) assert.equal(recognizedArchitecturePath(path), true, path);
  assert.equal(recognizedArchitecturePath('notes.txt'), false);
});

test('extracts imports with AST grammars for the expanded language set', () => {
  const extraction = extractArchitectureGraph({ repositories: [repo([
    ['src/Main.java', 'package demo;\nimport java.util.List;\nclass Main {}'],
    ['src/App.kt', 'package demo\nimport kotlin.collections.List\nclass App'],
    ['src/lib.rs', 'use crate::worker::run;\nfn main() {}'],
    ['lib/worker.rb', "require_relative './jobs'\nclass Worker; end"],
    ['src/Program.cs', 'using System.Collections.Generic;\nclass Program {}'],
  ])] });
  assert.equal(extraction.completeness, 'complete');
  assert.deepEqual(new Set(extraction.claims.map(({ resolver }) => resolver)), new Set(['java_import', 'kotlin_import', 'rust_use', 'ruby_require', 'csharp_using']));
  assert.ok(extraction.claims.every(({ semantic_strength }) => semantic_strength === 'syntactic_import'));
});

test('manifest projects own Rust, C#, Maven, Gradle, and npm workspace components without pretending to be deployments', () => {
  const repository = repo([
    ['crates/api/Cargo.toml', '[package]\nname = "api"\n[dependencies]\njobs = { path = "../jobs" }'],
    ['crates/api/src/lib.rs', 'use crate::handler::run;'], ['crates/api/src/handler.rs', 'pub fn run() {}'],
    ['crates/jobs/Cargo.toml', '[package]\nname = "jobs"'], ['crates/jobs/src/lib.rs', 'pub fn work() {}'],
    ['src/App/App.csproj', '<Project><PropertyGroup><AssemblyName>App</AssemblyName></PropertyGroup><ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup></Project>'],
    ['src/App/Program.cs', 'using Acme.Lib; class Program {}'], ['src/Lib/Lib.csproj', '<Project><PropertyGroup><AssemblyName>Lib</AssemblyName></PropertyGroup></Project>'], ['src/Lib/Thing.cs', 'namespace Acme.Lib; class Thing {}'],
    ['java/pom.xml', '<project><artifactId>parent</artifactId><modules><module>worker</module></modules></project>'],
    ['java/worker/pom.xml', '<project><artifactId>worker</artifactId></project>'], ['java/worker/src/main/java/com/acme/Worker.java', 'package com.acme; class Worker {}'],
    ['gradle/settings.gradle', "rootProject.name = 'gradle-root'\ninclude ':worker'"], ['gradle/worker/build.gradle', "plugins { id 'java' }"],
    ['gradle/worker/src/main/java/com/acme/Job.java', 'package com.acme; class Job {}'],
    ['apps/web/package.json', '{"name":"@acme/web"}'], ['apps/web/app.ts', "import ui from '@acme/ui'"],
    ['packages/ui/package.json', '{"name":"@acme/ui"}'], ['packages/ui/index.ts', 'export default 1'],
  ]);
  const extraction = extractArchitectureGraph({ repositories: [repository] }); const inventory = toOrgInventory(repository, extraction); const graph = buildOrgGraph({ inventories: [inventory] });
  assert.equal(extraction.completeness, 'complete');
  for (const ecosystem of ['cargo', 'msbuild', 'maven', 'gradle', 'npm']) assert.ok(inventory.services.some(({ id, boundaryRole }) => id.startsWith(`project:${ecosystem}:`) && boundaryRole === 'project'), ecosystem);
  assert.equal(inventory.components.find(({ id }) => id === 'crates/api/src').serviceId, 'project:cargo:crates/api');
  assert.equal(inventory.components.find(({ id }) => id === 'src/App').serviceId, 'project:msbuild:src/App');
  assert.equal(inventory.components.find(({ id }) => id === 'gradle/worker/src/main/java/com/acme').serviceId, 'project:gradle:gradle/worker');
  assert.equal(inventory.components.find(({ id }) => id === 'apps/web').serviceId, 'project:npm:apps/web');
  assert.ok(graph.edges.some(({ mechanism, resolution }) => mechanism === 'msbuild_project_reference' && resolution === 'resolved'));
  assert.ok(graph.edges.some(({ mechanism, resolution }) => mechanism === 'gradle_project_reference' && resolution === 'resolved'));
  assert.ok(graph.edges.some(({ mechanism, resolution }) => mechanism === 'node_import' && resolution === 'resolved'));
  assert.ok(buildEvidencePack(graph, { scope: 'lld' }).eligible);
  assert.equal(buildEvidencePack(graph, { scope: 'service' }).eligible, false);
});

test('project ownership is order-independent and cross-ecosystem collisions remain unresolved', () => {
  const files = [
    ['settings.gradle', "rootProject.name = 'actual-name'"],
    ['build.gradle', "plugins { id 'java' }"],
    ['src/main/java/com/acme/App.java', 'package com.acme; class App {}'],
  ];
  const analyze = (ordered) => { const repository = repo(ordered); const extraction = extractArchitectureGraph({ repositories: [repository] }); const inventory = toOrgInventory(repository, extraction); return { extraction, inventory, graph: buildOrgGraph({ inventories: [inventory] }) }; };
  const forward = analyze(files); const reverse = analyze([...files].reverse());
  assert.equal(forward.graph.buildId, reverse.graph.buildId);
  assert.equal(forward.inventory.services.find(({ id }) => id === 'project:gradle:.').name, 'actual-name');

  const collisionRepository = repo([['package.json', '{"name":"web"}'], ['Cargo.toml', '[package]\nname="native"'], ['src/app.ts', 'export default 1'], ['src/lib.rs', 'pub fn run() {}']]);
  const collisionInventory = toOrgInventory(collisionRepository, extractArchitectureGraph({ repositories: [collisionRepository] }));
  assert.ok(collisionInventory.diagnostics.some(({ code, path }) => code === 'ambiguous_component_ownership' && path === '.'));
  assert.ok(collisionInventory.components.every(({ serviceId }) => serviceId === 'repository'));
});

test('adapts plugin extraction into an end-to-end cross-repository organization graph', () => {
  const consumer = repo([['go.mod', 'module example.com/gateway'], ['proto/gateway.proto', 'syntax = "proto3";\nimport "common.proto";']], { repository_id: 'acme/gateway', revision: 'aaa' });
  const owner = repo([['go.mod', 'module example.com/users'], ['common.proto', 'syntax = "proto3";\nmessage User {}']], { repository_id: 'acme/users', revision: 'bbb' });
  const consumerExtraction = extractArchitectureGraph({ repositories: [consumer] });
  const ownerExtraction = extractArchitectureGraph({ repositories: [owner] });
  const inventories = [toOrgInventory(consumer, consumerExtraction), toOrgInventory(owner, ownerExtraction)];
  const graph = buildOrgGraph({ inventories, requiredRepoIds: ['acme/gateway', 'acme/users'] });
  const contractEdge = graph.edges.find(({ contractKey }) => contractKey === 'common.proto');
  assert.equal(graph.complete, true);
  assert.equal(contractEdge.resolution, 'resolved');
  assert.equal(contractEdge.quizEligible, true);
  assert.match(contractEdge.targetId, /^acme\/users::component::/);
});

test('same-repository contract claims include importing and target contract evidence', () => {
  const repository = repo([['go.mod', 'module example.com/service'], ['proto/api.proto', 'syntax = "proto3";\nimport "proto/common.proto";'], ['proto/common.proto', 'syntax = "proto3";\nmessage Common {}']]);
  const extraction = extractArchitectureGraph({ repositories: [repository] });
  const graph = buildOrgGraph({ inventories: [toOrgInventory(repository, extraction)] });
  const edge = graph.edges.find(({ contractKey }) => contractKey === 'proto/common.proto');
  assert.equal(edge.quizEligible, true);
  assert.deepEqual(new Set(edge.evidence.map(({ path }) => path)), new Set(['proto/api.proto', 'proto/common.proto']));
});

test('unresolved synthetic repository identity cannot produce service or HLD packs', () => {
  const consumer = repo([['a.proto', 'syntax = "proto3";\nimport "b.proto";']], { repository_id: 'repo-a', revision: 'aaa' });
  const owner = repo([['b.proto', 'syntax = "proto3";']], { repository_id: 'repo-b', revision: 'bbb' });
  const extraction = extractArchitectureGraph({ repositories: [consumer, owner] });
  const graph = buildOrgGraph({ inventories: [toOrgInventory(consumer, extraction), toOrgInventory(owner, extraction)] });
  assert.ok(graph.nodes.filter(({ kind }) => kind === 'service').every(({ resolutionState }) => resolutionState === 'unresolved'));
  assert.equal(graph.edges[0].quizEligible, true, 'the component-level contract claim remains proven');
  assert.equal(buildEvidencePack(graph, { scope: 'service' }).eligible, false);
  assert.equal(buildEvidencePack(graph, { scope: 'hld' }).eligible, false);
});

test('ignores commented imports and ordinary Go string literals', () => {
  const repository = repo([
    ['web/app.ts', "// import ghost from './ghost'\nconst url = 'http://example.com'"],
    ['main.go', 'package main\n// import "example.com/ghost"\nvar url = "example.com/not-an-import"\n'],
  ]);
  const extraction = extractArchitectureGraph({ repositories: [repository] });
  assert.deepEqual(extraction.claims, []);
});

test('bounded Protobuf, SQL, and Terraform parsers reject comment and string false positives', () => {
  const repository = repo([
    ['contracts/api.proto', `syntax = "proto3";
// import "ghost.proto";
/* service Ghost { rpc Vanish(X) returns (Y); import "also-ghost.proto"; } */
import "real.proto";
service Real { rpc Run(X) returns (Y); }
`],
    ['schema.sql', `-- CREATE TABLE ghost(id int REFERENCES absent(id));
/* ALTER TABLE x ADD FOREIGN KEY (id) REFERENCES block_ghost(id); */
SELECT 'REFERENCES string_ghost(id); CREATE TABLE string_table(id int)';
CREATE TABLE "real_table" (id int, parent int REFERENCES "parent_table"(id));
`],
    ['infra/main.tf', `# resource "aws_s3_bucket" "ghost" {}
/* data "aws_region" "block_ghost" {} module.block_ghost.id */
resource "aws_s3_bucket" "real" {}
module "worker" { source = "./worker" }
output "literal" { value = "module.string_ghost.id" }
output "document" { value = <<EOF
module.heredoc_ghost.id
EOF
}
output "real" { value = module.worker.id }
`],
  ]);
  const extraction = extractArchitectureGraph({ repositories: [repository] });
  assert.ok(extraction.claims.some(({ to }) => to === 'proto:real.proto'));
  assert.ok(!extraction.claims.some(({ to }) => /ghost/.test(to)));
  assert.ok(extraction.discoveries.some(({ kind, name }) => kind === 'service_contract' && name === 'Real'));
  assert.ok(!extraction.discoveries.some(({ name }) => /Ghost|ghost|string_table/.test(name)));
  assert.ok(extraction.discoveries.some(({ kind, name }) => kind === 'datastore_resource' && name === 'real_table'));
  assert.ok(extraction.claims.some(({ to }) => to === 'table:parent_table'));
  assert.ok(extraction.discoveries.some(({ kind, name }) => kind === 'infrastructure_resource' && name === 'aws_s3_bucket.real'));
  assert.ok(extraction.discoveries.some(({ kind, name }) => kind === 'infrastructure_resource' && name === 'worker'));
  assert.ok(extraction.claims.some(({ to }) => to === 'terraform:module:worker.id'));
});

test('workspace parsers cover Cargo members, multi-module Gradle, and both solution formats', () => {
  const repository = repo([
    ['Cargo.toml', '[workspace]\nmembers = ["crates/api", "crates/jobs", "plugins/*"]'],
    ['crates/api/Cargo.toml', '[package]\nname="api"'], ['crates/jobs/Cargo.toml', '[package]\nname="jobs"'],
    ['settings.gradle', "include ':api', ':worker', ':nested:jobs'\n// include ':ghost'"],
    ['api/build.gradle', 'plugins { id "java" }'], ['worker/build.gradle', 'plugins { id "java" }'], ['nested/jobs/build.gradle', 'plugins { id "java" }'],
    ['Acme.sln', 'Project("{TYPE}") = "App", "src\\App\\App.csproj", "{APP}"\nEndProject'],
    ['Acme.slnx', '<Solution><Project Path="src/Lib/Lib.csproj" /></Solution>'],
    ['src/App/App.csproj', '<Project><PropertyGroup><AssemblyName>App</AssemblyName></PropertyGroup></Project>'],
    ['src/Lib/Lib.csproj', '<Project><PropertyGroup><AssemblyName>Lib</AssemblyName></PropertyGroup></Project>'],
  ]);
  const extraction = extractArchitectureGraph({ repositories: [repository] });
  const references = extraction.claims.filter(({ claim_kind }) => claim_kind === 'project_reference');
  for (const resolver of ['cargo_workspace_member', 'gradle_project_reference', 'solution_project_reference']) assert.ok(references.some((claim) => claim.resolver === resolver), resolver);
  assert.equal(references.filter(({ resolver }) => resolver === 'cargo_workspace_member').length, 2, 'unresolved Cargo globs are intentionally not invented');
  assert.equal(references.filter(({ resolver }) => resolver === 'gradle_project_reference').length, 3);
  assert.equal(references.filter(({ resolver }) => resolver === 'solution_project_reference').length, 2);
});

test('malformed workspace manifests fail closed with diagnostics', () => {
  for (const [path, content] of [
    ['Cargo.toml', '[package\nname = "broken"'],
    ['Broken.csproj', '<Project><ItemGroup></Project>'],
    ['pom.xml', '<project><artifactId>broken</project>'],
    ['Broken.slnx', '<Solution><Project Path="x.csproj"></Solution>'],
  ]) {
    const extraction = extractArchitectureGraph({ repositories: [repo([[path, content]])] });
    assert.equal(extraction.completeness, 'incomplete', path);
    assert.ok(extraction.diagnostics.some(({ plugin, code }) => plugin === 'workspace-manifests' && code === 'invalid_workspace_manifest'), path);
  }
});

test('distinguishes Go raw-string documentation from legal raw import paths', () => {
  const documented = repo([['go.mod', 'module example.com/app'], ['docs.go', 'package app\nvar docs = `\nimport "example.com/ghost"\n`\n']]);
  assert.deepEqual(extractArchitectureGraph({ repositories: [documented] }).claims, []);
  const imported = repo([['go.mod', 'module example.com/app'], ['main.go', 'package main\nimport `example.com/real/pkg`\n']]);
  assert.equal(extractArchitectureGraph({ repositories: [imported] }).claims[0].to, 'go-package:example.com/real/pkg');
  const slashEnding = repo([['go.mod', 'module example.com/app'], ['docs.go', 'package app\nvar docs = `ends in slash \\`\n/*\nimport "example.com/ghost"\n*/\n']]);
  assert.deepEqual(extractArchitectureGraph({ repositories: [slashEnding] }).claims, []);
});

test('resolves uniquely owned Go packages across repositories', () => {
  const consumer = repo([['go.mod', 'module example.com/gateway'], ['client/client.go', 'package client\nimport "example.com/users/api"\n']], { repository_id: 'gateway', revision: 'aaa' });
  const owner = repo([['go.mod', 'module example.com/users'], ['api/server.go', 'package api\n']], { repository_id: 'users', revision: 'bbb' });
  const extraction = extractArchitectureGraph({ repositories: [consumer, owner] });
  const graph = buildOrgGraph({ inventories: [toOrgInventory(consumer, extraction), toOrgInventory(owner, extraction)] });
  const edge = graph.edges.find(({ contractKey }) => contractKey === 'example.com/users/api');
  assert.equal(edge.resolution, 'resolved');
  assert.equal(edge.quizEligible, true);
  assert.deepEqual(new Set(edge.evidence.map(({ repoId }) => repoId)), new Set(['gateway', 'users']));
});

test('maps components to the nearest Go module service in a monorepo', () => {
  const repository = repo([
    ['services/api/go.mod', 'module example.com/api\n'],
    ['services/api/handler/handler.go', 'package handler\n'],
    ['services/worker/go.mod', 'module example.com/worker\n'],
    ['services/worker/jobs/jobs.go', 'package jobs\n'],
  ]);
  const inventory = toOrgInventory(repository, extractArchitectureGraph({ repositories: [repository] }));
  const apiId = 'go-module:services/api:example.com/api';
  const workerId = 'go-module:services/worker:example.com/worker';
  assert.ok(inventory.services.some(({ id, name }) => id === apiId && name === 'api'));
  assert.ok(inventory.services.some(({ id, name }) => id === workerId && name === 'worker'));
  assert.equal(inventory.components.find(({ id }) => id === 'services/api/handler').serviceId, apiId);
  assert.equal(inventory.components.find(({ id }) => id === 'services/worker/jobs').serviceId, workerId);
});

test('keeps same-basename Go modules as distinct services and classifies their edge across services', () => {
  const repository = repo([
    ['services/acme/go.mod', 'module github.com/acme/api\n'],
    ['services/acme/client/client.go', 'package client\nimport "github.com/acquired/api/pkg"\n'],
    ['services/acquired/go.mod', 'module github.com/acquired/api\n'],
    ['services/acquired/pkg/server.go', 'package pkg\n'],
  ]);
  const inventory = toOrgInventory(repository, extractArchitectureGraph({ repositories: [repository] }));
  const moduleServices = inventory.services.filter(({ id }) => id.startsWith('go-module:'));
  assert.equal(moduleServices.length, 2);
  assert.deepEqual(moduleServices.map(({ name }) => name), ['api', 'api']);
  assert.equal(new Set(moduleServices.map(({ id }) => id)).size, 2);

  const graph = buildOrgGraph({ inventories: [inventory] });
  const edge = graph.edges.find(({ contractKey }) => contractKey === 'github.com/acquired/api/pkg');
  assert.equal(edge.resolution, 'resolved');
  const source = graph.nodes.find(({ id }) => id === edge.sourceId);
  const target = graph.nodes.find(({ id }) => id === edge.targetId);
  assert.notEqual(source.serviceId, target.serviceId);
  assert.match(source.serviceId, /github\.com\/acme\/api/);
  assert.match(target.serviceId, /github\.com\/acquired\/api/);
});

test('a configurable path convention resolves monorepo services and proven cross-service paths', () => {
  const convention = createServiceBoundaryConventionPlugin({
    id: 'service-groups',
    boundaryPatterns: [/^cmd\/service_groups\/([^/]+)\/service_group\.go$/],
    ownershipPatterns: [/^(?:cmd\/service_groups|src|gen)\/([^/]+)\//],
  });
  const repository = repo([
    ['go.mod', 'module example.com/mono\n'],
    ['cmd/service_groups/gateway/service_group.go', 'package gateway\nimport "example.com/mono/gen/engine/api"\n'],
    ['cmd/service_groups/engine/service_group.go', 'package engine\nimport "example.com/mono/gen/store/api"\n'],
    ['cmd/service_groups/store/service_group.go', 'package store\n'],
    ['gen/engine/api/service.go', 'package api\n'],
    ['gen/store/api/service.go', 'package api\n'],
    ['src/gateway/handler.go', 'package gateway\n'],
  ]);
  const registry = createExtractorRegistry([...CORE_STACK_PLUGINS, convention]);
  const extraction = extractArchitectureGraph({ repositories: [repository], registry });
  const graph = buildOrgGraph({ inventories: [toOrgInventory(repository, extraction)] });
  assert.deepEqual(graph.nodes.filter(({ kind, name }) => kind === 'service' && ['gateway', 'engine', 'store'].includes(name)).map(({ name }) => name).sort(), ['engine', 'gateway', 'store']);
  const servicePack = buildEvidencePack(graph, { scope: 'service' });
  const hldPack = buildEvidencePack(graph, { scope: 'hld', maxHops: 3 });
  assert.equal(servicePack.eligible, true);
  assert.equal(hldPack.eligible, true);
  assert.ok(hldPack.path_count > 0);
});

test('wide source directories keep one deterministic component witness and linear edge evidence', () => {
  const sourceCount = 400;
  const files = [
    ['go.mod', 'module example.com/wide\n'],
    ['target/server.go', 'package target\n'],
    ...Array.from({ length: sourceCount }, (_, index) => [
      `wide/file-${String(index).padStart(3, '0')}.go`,
      'package wide\nimport "example.com/wide/target"\n',
    ]),
  ];
  const repository = repo(files);
  const reversedRepository = repo([...files].reverse());
  const extraction = extractArchitectureGraph({ repositories: [repository] });
  const reversedExtraction = extractArchitectureGraph({ repositories: [reversedRepository] });
  const wide = extraction.discoveries.find(({ logical_id }) => logical_id.endsWith(':component:wide'));
  const reversedWide = reversedExtraction.discoveries.find(({ logical_id }) => logical_id.endsWith(':component:wide'));
  assert.equal(wide.evidence.length, 1);
  assert.equal(wide.evidence[0].path, 'wide/file-000.go');
  assert.deepEqual(reversedWide.evidence, wide.evidence);

  const inventory = toOrgInventory(repository, extraction);
  const component = inventory.components.find(({ id }) => id === 'wide');
  assert.equal(component.evidence.length, 1);
  assert.equal(inventory.contracts.find(({ kind, key }) => kind === 'go_package' && key === 'example.com/wide/wide').evidence.length, 2);

  const graph = buildOrgGraph({ inventories: [inventory] });
  assert.equal(graph.edges.length, sourceCount);
  assert.ok(graph.edges.every(({ resolution, quizEligible, evidence }) => resolution === 'resolved' && quizEligible && evidence.length <= 4));
  assert.ok(graph.edges.reduce((count, edge) => count + edge.evidence.length, 0) <= sourceCount * 4);
  assert.equal(buildOrgGraph({ inventories: [toOrgInventory(reversedRepository, reversedExtraction)] }).buildId, graph.buildId);
});

test('file evidence hashes are reused safely and invalidated when caller content changes', () => {
  const repository = repo([['main.go', 'package main\nimport "example.com/one"\nimport "example.com/two"\n']]);
  const first = extractArchitectureGraph({ repositories: [repository] });
  assert.equal(new Set(first.claims.map(({ evidence: [ref] }) => ref.content_hash)).size, 1);
  const firstHash = first.claims[0].evidence[0].content_hash;
  repository.files[0].content = 'package main\nimport "example.com/three"\n';
  const secondHash = extractArchitectureGraph({ repositories: [repository] }).claims[0].evidence[0].content_hash;
  assert.notEqual(secondHash, firstHash);
});

test('blob extraction cache reuses unchanged files across revisions and rebinds evidence', () => {
  const entries = new Map(); const stats = { hits: 0, misses: 0, writes: 0 };
  const blobCache = {
    get(key) { const value = entries.get(key); if (value) stats.hits += 1; else stats.misses += 1; return value ? structuredClone(value) : undefined; },
    set(key, value) { entries.set(key, structuredClone(value)); stats.writes += 1; },
    flush() {},
  };
  const files = [['go.mod', 'module example.com/cache\n'], ['pkg/main.go', 'package pkg\nimport "example.com/dependency"\n']];
  const firstRepository = repo(files, { revision: 'rev-one' });
  const first = extractArchitectureGraph({ repositories: [firstRepository], blobCache });
  assert.equal(stats.writes, 2);
  assert.doesNotMatch(JSON.stringify([...entries.values()]), /package pkg|module example/);

  const secondRepository = repo(files, { revision: 'rev-two' });
  const second = extractArchitectureGraph({ repositories: [secondRepository], blobCache });
  assert.equal(stats.hits, 2);
  assert.ok(second.claims.every(({ evidence: [ref] }) => ref.revision === 'rev-two'));
  assert.deepEqual(second.claims.map(({ to }) => to), first.claims.map(({ to }) => to));

  secondRepository.files[1].content = 'package pkg\nimport "example.com/changed"\n';
  const changed = extractArchitectureGraph({ repositories: [secondRepository], blobCache });
  assert.equal(stats.writes, 3, 'only the changed blob is extracted again');
  assert.equal(changed.claims[0].to, 'go-package:example.com/changed');
});

test('astral characters preserve SQL, Protobuf and Terraform evidence coordinates', () => {
  const fixtures = [
    ['schema.sql', '-- 😀\r\n/* 😀\nCREATE TABLE ghost(id int); */\nSELECT \'😀 CREATE TABLE hidden(id int);\';\nCREATE TABLE jobs(id int);\n', 'jobs', 5],
    ['api.proto', '// 😀\n/* 😀\nservice Ghost {} */\noption note = "😀 service Hidden {}";\nservice Jobs {}\n', 'Jobs', 5],
    ['main.tf', '# 😀\n/* 😀\nresource "fake" "ghost" {} */\noutput "note" { value = "😀 module.hidden.id" }\nresource "aws_sqs_queue" "jobs" {}\n', 'aws_sqs_queue.jobs', 5],
  ];
  for (const [path, content, name, line] of fixtures) {
    const extraction = extractArchitectureGraph({ repositories: [repo([[path, content]])] });
    const found = extraction.discoveries.find((entry) => entry.name === name);
    assert.ok(found, path);
    assert.equal(found.evidence[0].line_start, line, path);
    assert.equal(found.evidence[0].line_end, line, path);
    assert.ok(!extraction.discoveries.some((entry) => /ghost|hidden/i.test(entry.name)), path);
    assert.ok(!extraction.claims.some((entry) => /ghost|hidden/i.test(entry.to)), path);
  }
});

test('computed and shadowed loaders cannot create eligible component relationships', () => {
  const graphFor = (content) => {
    const repository = repo([['package.json', '{"name":"fixture"}'], ['a.js', content], ['worker/b.js', 'export default 1;']]);
    return buildOrgGraph({ inventories: [toOrgInventory(repository, extractArchitectureGraph({ repositories: [repository] }))] });
  };
  for (const content of [
    'const dep = import("./worker/b.js" + ".missing");',
    'const dep = require("./worker/b.js" + ".missing");',
    'const dep = import(transform("./worker/b.js"));',
    'const dep = require(transform("./worker/b.js"));',
    'function require(x) { return 0; } const dep = require("./worker/b.js");',
    'function f(require) { return require("./worker/b.js"); }',
    'for (const require of [x => x]) { require("./worker/b.js"); }',
    'for (let require in values) { require("./worker/b.js"); }',
    'for (const { require } of values) { require("./worker/b.js"); }',
    'for (const [require] of values) { require("./worker/b.js"); }',
    String.raw`const requ\u0069re = x => x; require("./worker/b.js");`,
    String.raw`const requ\u{69}re = x => x; require("./worker/b.js");`,
  ]) {
    const graph = graphFor(content);
    assert.ok(!graph.edges.some(({ quizEligible }) => quizEligible), content);
    assert.equal(buildEvidencePack(graph, { scope: 'lld' }).eligible, false, content);
  }
  for (const content of ['import x from "./worker/b.js";', 'const dep = import("./worker/b.js");', 'const dep = require("./worker/b.js");']) {
    const graph = graphFor(content);
    assert.equal(graph.edges.filter(({ quizEligible }) => quizEligible).length, 1, content);
    assert.equal(buildEvidencePack(graph, { scope: 'lld' }).eligible, true, content);
  }
});

test('runtime declarations cannot create false graph evidence and escaped literals resolve their actual files', () => {
  const graphFor = (path, content) => {
    const repository = repo([['package.json', '{"name":"fixture"}'], [path, content], ['worker/b.js', 'export default 1;']]);
    return buildOrgGraph({ inventories: [toOrgInventory(repository, extractArchitectureGraph({ repositories: [repository] }))] });
  };
  for (const path of ['a.jsx', 'a.ts', 'a.mts', 'a.cts', 'a.tsx']) {
    for (const declaration of ['class require {}']) {
      const graph = graphFor(path, `${declaration} require("./worker/b.js");`);
      assert.ok(!graph.edges.some(({ quizEligible }) => quizEligible), `${path}: ${declaration}`);
      assert.equal(buildEvidencePack(graph, { scope: 'lld' }).eligible, false);
    }
  }
  for (const path of ['a.jsx', 'a.ts', 'a.mts', 'a.cts', 'a.tsx']) {
    assert.equal(buildEvidencePack(graphFor(path, 'const C = class require {}; require("./worker/b.js");'), { scope: 'lld' }).eligible, true);
  }
  for (const declaration of ['enum require { value }', 'namespace require { export const value = 1; }']) {
    const graph = graphFor('a.ts', `${declaration}; require("./worker/b.js");`);
    assert.ok(!graph.edges.some(({ quizEligible }) => quizEligible), declaration);
    assert.equal(buildEvidencePack(graph, { scope: 'lld' }).eligible, false);
  }
  for (const source of [String.raw`require("./worker/\u0062.js");`, String.raw`import("./worker/\x62.js");`, String.raw`import x from "./worker/\u{62}.js";`, String.raw`export { default } from "./worker/\u0062.js";`]) {
    const graph = graphFor('a.js', source);
    assert.equal(graph.edges.filter(({ quizEligible }) => quizEligible).length, 1, source);
    assert.equal(buildEvidencePack(graph, { scope: 'lld' }).eligible, true);
  }
});

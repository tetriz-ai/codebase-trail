// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeArchitectureRepositories, generateArchitectureLearningItem } from './server.mjs';

const repository = (content) => [{ repository_id: 'example/compose', revision: 'abc', tree_complete: true, files: [{ path: 'compose.yaml', content, complete: true }] }];
const document = (body, unit = '  ') => `services:\n${unit}api:\n${unit.repeat(2)}image: example/api\n${body}${unit}worker:\n${unit.repeat(2)}image: example/worker\n`;

for (const [name, body] of [
  ['nested extension mapping', '    x-documentation:\n      depends_on:\n        - worker\n'],
  ['literal scalar', '    x-documentation: |\n      depends_on:\n        - worker\n'],
  ['folded scalar', '    command: >-\n      depends_on:\n        - worker\n'],
  ['quoted multiline scalar', '    command: "documentation\n      depends_on:\n        - worker\n      end"\n'],
  ['nested dependency properties', '    depends_on:\n      unrelated:\n        x-documentation:\n          worker:\n'],
  ['mixed mapping and sequence', '    depends_on:\n      unrelated: {}\n      - worker\n'],
  ['inconsistent indentation', '    depends_on:\n      worker: {}\n       other: {}\n'],
  ['duplicate keys', '    depends_on:\n      worker: {}\n      worker: {}\n'],
  ['unsupported inline dependencies', '    depends_on: [worker]\n'],
]) test(`Compose ${name} cannot prove an api-to-worker dependency or publish a question`, async () => {
  const repositories = repository(document(body));
  const analysis = analyzeArchitectureRepositories({ repositories });
  assert.ok(!analysis.scopes.service.evidence_pack.claims.some((entry) => entry.sourceId.endsWith(':api') && entry.targetId.endsWith(':worker')));
  let calls = 0;
  const result = await generateArchitectureLearningItem({ scope: 'service', repositories }, { complete_json: async () => { calls += 1; throw new Error('Unproven dependency reached model'); } });
  assert.equal(result.status, 'abstained');
  assert.equal(calls, 0);
});

for (const unit of ['  ', '    ']) for (const long of [false, true]) test(`Compose direct ${long ? 'long' : 'short'} dependencies preserve ${unit.length}-space indentation and source coordinates`, () => {
  const body = `${unit.repeat(2)}x-documentation:\n${unit.repeat(3)}depends_on:\n${unit.repeat(4)}- ghost\n${unit.repeat(2)}depends_on: # direct field\n${unit.repeat(3)}${long ? 'worker: # actual service\n' + unit.repeat(4) + 'condition: service_started' : '- worker # actual service'}\n`;
  const analysis = analyzeArchitectureRepositories({ repositories: repository(document(body, unit)) });
  assert.equal(analysis.scopes.service.evidence_pack.eligible, true);
  const claims = analysis.scopes.service.evidence_pack.claims;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].kind, 'depends_on');
  assert.ok(claims[0].targetId.endsWith(':worker'));
  assert.ok(claims[0].evidence.every((entry) => entry.path === 'compose.yaml'));
});

test('quoted Compose service and dependency names retain direct structural meaning', () => {
  const content = 'services:\n  "api":\n    depends_on:\n      \'worker\': {}\n  worker:\n    image: worker\n';
  const analysis = analyzeArchitectureRepositories({ repositories: repository(content) });
  assert.equal(analysis.scopes.service.evidence_pack.eligible, true);
  assert.equal(analysis.scopes.service.evidence_pack.claims.length, 1);
});

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildServicePathUniverse, enumerateServicePaths, sampleServicePath } from './path-universe.mjs';

const edge = (id, sourceServiceId, targetServiceId) => ({ id, sourceServiceId, targetServiceId });
const claims = [edge('ab1', 'a', 'b'), edge('ab2', 'a', 'b'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a'), edge('cd', 'c', 'd'), edge('self', 'd', 'd')];

test('counts and samples every directed acyclic path including parallel evidence alternatives', () => {
  const universe = buildServicePathUniverse(claims, { maxHops: 3 });
  const paths = [...enumerateServicePaths(universe)];
  assert.equal(universe.path_count, paths.length);
  assert.equal(new Set(paths.map(JSON.stringify)).size, paths.length);
  const sampled = paths.map((_, index) => sampleServicePath(universe, { random: () => (index + 0.5) / paths.length }));
  assert.deepEqual(sampled, paths);
  for (const path of sampled) {
    const edges = path.map((id) => claims.find((claim) => claim.id === id));
    assert.ok(edges.length >= 2 && edges.length <= 3);
    assert.ok(edges.slice(1).every((claim, index) => claim.sourceServiceId === edges[index].targetServiceId));
    const nodes = [edges[0].sourceServiceId, ...edges.map((claim) => claim.targetServiceId)];
    assert.equal(new Set(nodes).size, nodes.length);
  }
});

test('respects selected boundaries, including boundaries absent from eligible relationships', () => {
  const universe = buildServicePathUniverse(claims, { maxHops: 3, anchors: ['d'] });
  const paths = [...enumerateServicePaths(universe)];
  assert.equal(universe.path_count, paths.length);
  assert.ok(paths.length > 0);
  assert.ok(paths.every((path) => path.includes('cd')));
  const isolated = buildServicePathUniverse(claims, { anchors: ['isolated'] });
  assert.equal(isolated.path_count, 0);
  assert.equal(sampleServicePath(isolated), null);
  assert.deepEqual([...enumerateServicePaths(isolated)], []);
});

test('samples only complete paths with materialized evidence and handles empty universes', () => {
  const universe = buildServicePathUniverse(claims);
  const eligibleClaimIds = new Set(['ab2', 'bc']);
  assert.deepEqual(sampleServicePath(universe, { eligibleClaimIds }), ['ab2', 'bc']);
  assert.equal(sampleServicePath(universe, { eligibleClaimIds: new Set(['bc']) }), null);
  assert.equal(sampleServicePath(buildServicePathUniverse([])), null);
  assert.throws(() => buildServicePathUniverse(claims, { maxHops: 1 }), RangeError);
  assert.throws(() => buildServicePathUniverse(claims, { maxHops: 9 }), RangeError);
});

test('retains exact counts and samples paths above Number safe integer range', () => {
  const width = 100;
  const dense = Array.from({ length: 8 }, (_, hop) => Array.from({ length: width }, (_, index) => edge(`${hop}:${index}`, `s${hop}`, `s${hop + 1}`))).flat();
  const universe = buildServicePathUniverse(dense, { maxHops: 8 });
  const expected = Array.from({ length: 7 }, (_, index) => BigInt(7 - index) * BigInt(width) ** BigInt(index + 2)).reduce((sum, value) => sum + value, 0n);
  assert.equal(universe.path_count, expected.toString());
  assert.doesNotThrow(() => JSON.stringify(universe));
  for (const random of [() => 0, () => 0.5, () => 1 - Number.EPSILON]) {
    const path = sampleServicePath(universe, { random });
    assert.ok(path.length >= 2 && path.length <= 8);
    assert.ok(path.every((id) => dense.some((claim) => claim.id === id)));
  }
});

test('production evidence pack and prompt sampling fit a 96 MB heap with billions of HLD paths', () => {
  const script = `
    import assert from 'node:assert/strict';
    import {buildOrgGraph,buildEvidencePack} from ${JSON.stringify(new URL('./org-graph.mjs', import.meta.url).href)};
    import {buildArchitectureLearningInput,compactArchitectureGenerationEvidence} from ${JSON.stringify(new URL('./architecture-learning.mjs', import.meta.url).href)};
    const ev = path => [{path,startLine:1,endLine:2,contentHash:'hash:'+path}];
    const services = Array.from({length:5},(_,i)=>({id:'s'+i,evidence:ev('s'+i+'/main.go')}));
    const dependencies = Array.from({length:4},(_,hop)=>Array.from({length:500},(_,i)=>({source:'s'+hop,target:'s'+(hop+1),evidence:ev(hop+'/client-'+i+'.go')}))).flat();
    const graph=buildOrgGraph({inventories:[{repoId:'dense',commitSha:'abc',complete:true,services,dependencies}]});
    const pack=buildEvidencePack(graph,{scope:'hld',maxHops:4});
    assert.equal(pack.path_count,62750750000);
    assert.equal(pack.claims.length,2000);
    assert.deepEqual(pack.paths,[]);
    const input=buildArchitectureLearningInput(pack);
    const excerpts=pack.claims.map(claim=>({claim_id:claim.id,excerpt:'grounded dependency evidence'}));
    for(let i=0;i<20;i++) {
      const selected=compactArchitectureGenerationEvidence(input,excerpts);
      assert.equal(selected.input.paths.length,1);
      assert.ok(selected.input.paths[0].length>=2 && selected.input.paths[0].length<=4);
      assert.ok(!('path_universe' in selected.input));
      assert.ok(JSON.stringify(selected).length<20000);
    }
    console.log(JSON.stringify({path_count:pack.path_count,claim_count:pack.claims.length}));
  `;
  const output = execFileSync(process.execPath, ['--max-old-space-size=96', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
  assert.deepEqual(JSON.parse(output), { path_count: 62_750_750_000, claim_count: 2000 });
});

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { analyzeArchitectureRepositories, loadLocalArchitectureSnapshot } from './server.mjs';
import { architectureSmokeFailures } from './smoke-assertions.mjs';

const args = process.argv.slice(2); const requiredScopes = args.filter((value) => value.startsWith('--require-scope=')).map((value) => value.slice('--require-scope='.length));
const minimumResolvedEdges = Number(args.find((value) => value.startsWith('--min-resolved-edges='))?.slice('--min-resolved-edges='.length) ?? 1);
const allowNoEligibleScope = args.includes('--allow-no-eligible-scope');
const entries = args.filter((value) => !value.startsWith('--')).map((value) => {
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) throw new Error('Each checkout must use owner/repository=/absolute/path syntax.');
  return [value.slice(0, separator), value.slice(separator + 1)];
});
if (!entries.length) throw new Error('Usage: npm run test:architecture-smoke -- owner/repository=/absolute/path [...]');
if (!Number.isSafeInteger(minimumResolvedEdges) || minimumResolvedEdges < 0) throw new Error('--min-resolved-edges must be a non-negative integer.');
if (requiredScopes.some((scope) => !['lld', 'service', 'hld'].includes(scope))) throw new Error('--require-scope must be lld, service, or hld.');

const summaries = [];
const failures = [];
for (const [repositoryId, checkout] of entries) {
  const started = Date.now();
  const snapshot = await loadLocalArchitectureSnapshot(repositoryId, checkout);
  const analysis = analyzeArchitectureRepositories({ repositories: [snapshot] }, { server_acquired: true });
  const diagnosticCodes = analysis.graph.diagnostics.map(({ code }) => code);
  summaries.push({
    repository_id: repositoryId,
    revision: snapshot.revision,
    duration_ms: Date.now() - started,
    files: snapshot.files.length,
    bytes: snapshot.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    omission_reasons: Object.fromEntries([...new Set(snapshot.omissions.map(({ reason }) => reason))].sort().map((reason) => [reason, snapshot.omissions.filter((entry) => entry.reason === reason).length])),
    tree_complete: snapshot.tree_complete,
    graph_complete: analysis.graph.complete,
    boundaries: Object.fromEntries(['project', 'deployable', 'repository'].map((role) => [role, analysis.graph.nodes.filter((node) => node.kind === 'service' && node.boundaryRole === role).length])),
    components: analysis.graph.nodes.filter(({ kind }) => kind === 'component').length,
    edges: analysis.graph.edges.length,
    resolved_edges: analysis.graph.edges.filter(({ resolution }) => resolution === 'resolved').length,
    scopes: Object.fromEntries(Object.entries(analysis.scopes).map(([scope, value]) => [scope, {
      eligible: value.evidence_pack.eligible,
      reason: value.evidence_pack.reason ?? value.generation_input.reason ?? null,
      claims: value.evidence_pack.claims.length,
      paths: value.evidence_pack.path_count ?? value.evidence_pack.paths.length,
    }])),
    diagnostics: Object.fromEntries([...new Set(diagnosticCodes)].sort().map((code) => [code, diagnosticCodes.filter((value) => value === code).length])),
  });
  failures.push(...architectureSmokeFailures(repositoryId, snapshot, analysis, { allowNoEligibleScope, minimumResolvedEdges, requiredScopes }));
}
console.log(JSON.stringify(summaries, null, 2));
if (failures.length) { console.error(`Architecture smoke failed:\n- ${failures.join('\n- ')}`); process.exitCode = 1; }

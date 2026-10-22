// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { enumerateServicePaths } from "./path-universe.mjs";
import { ORG_GRAPH_LIMITS, buildEvidencePack, buildOrgGraph, canonicalHash, selectCurriculum } from "./org-graph.mjs";

const ev = (path) => [{ path, startLine: 1, endLine: 2, contentHash: `hash:${path}` }];
const repos = [
  {
    repoId: "github/acme/gateway", commitSha: "aaa", complete: true,
    services: [{ id: "gateway", evidence: ev("cmd/gateway/main.go") }],
    components: [{ id: "handler", serviceId: "gateway", evidence: ev("handler.go") }],
    dependencies: [{ source: "handler", contractKind: "protobuf", contractKey: "acme.UserService", evidence: ev("handler.go"), semanticStrength: "statically_bound_call" }],
  },
  {
    repoId: "github/acme/users", commitSha: "bbb", complete: true,
    services: [{ id: "users", evidence: ev("cmd/users/main.go") }],
    components: [{ id: "server", serviceId: "users", evidence: ev("server.go") }],
    contracts: [{ id: "user-api", kind: "protobuf", key: "acme.UserService", ownerId: "server", evidence: ev("user.proto") }],
    dependencies: [{ source: "server", target: "users", edgeKind: "reads", evidence: ev("store.go") }],
  },
];

test("builds deterministic immutable snapshots and uniquely resolves cross-repo contracts", () => {
  const graph = buildOrgGraph({ inventories: repos, requiredRepoIds: repos.map(({ repoId }) => repoId) });
  const again = buildOrgGraph({ inventories: [...repos].reverse(), requiredRepoIds: repos.map(({ repoId }) => repoId) });
  assert.equal(graph.buildId, again.buildId);
  assert.deepEqual(graph.revisions, { "github/acme/gateway": "aaa", "github/acme/users": "bbb" });
  assert.equal(graph.snapshots.length, 2);
  assert.ok(Object.isFrozen(graph.snapshots[0]));
  assert.equal(graph.complete, true);
  const edge = graph.edges.find(({ contractKey }) => contractKey === "acme.UserService");
  assert.equal(edge.resolution, "resolved");
  assert.equal(edge.targetId, "github/acme/users::component::server");
  assert.equal(edge.quizEligible, true);
  assert.ok(edge.evidence.some(({ repoId, path }) => repoId === "github/acme/users" && path === "user.proto"));
  assert.ok(edge.evidence.some(({ repoId, path }) => repoId === "github/acme/users" && path === "server.go"));
  assert.throws(() => graph.edges.push({}));
});

test("marks duplicate ownership ambiguous and ineligible", () => {
  const duplicate = structuredClone(repos[1]);
  duplicate.repoId = "github/acme/users-v2";
  duplicate.commitSha = "ccc";
  const graph = buildOrgGraph({ inventories: [...repos, duplicate] });
  const edge = graph.edges.find(({ contractKey }) => contractKey === "acme.UserService");
  assert.equal(edge.resolution, "ambiguous");
  assert.equal(edge.quizEligible, false);
  assert.equal(edge.candidateOwnerIds.length, 2);
  assert.ok(graph.diagnostics.some(({ code }) => code === "ambiguous_dependency"));
});

test("fails closed for missing, incomplete, or truncated repository snapshots", () => {
  const graph = buildOrgGraph({ inventories: [{ ...repos[0], complete: true, truncated: true }], requiredRepoIds: [repos[0].repoId, repos[1].repoId] });
  assert.equal(graph.complete, false);
  assert.deepEqual(buildEvidencePack(graph, { scope: "service" }), {
    scope: "service", eligible: false, reason: "incomplete_graph", claims: [], paths: [],
  });
});

test("curriculum anchors learner work and expands one hop in either direction", () => {
  const graph = buildOrgGraph({ inventories: repos });
  const curriculum = selectCurriculum(graph, { learnerNodeIds: ["github/acme/gateway::component::handler"] });
  assert.deepEqual(curriculum.anchorServiceIds, ["github/acme/gateway::service::gateway"]);
  assert.deepEqual(curriculum.serviceIds, ["github/acme/gateway::service::gateway", "github/acme/users::service::users"]);
});

test("selects LLD and service claims by architectural level", () => {
  const graph = buildOrgGraph({ inventories: repos });
  const curriculum = selectCurriculum(graph, { learnerNodeIds: ["github/acme/users::service::users"] });
  const lld = buildEvidencePack(graph, { scope: "lld", curriculum });
  const service = buildEvidencePack(graph, { scope: "service", curriculum });
  assert.equal(lld.eligible, true);
  assert.ok(lld.claims.every((claim) => claim.kind === "reads"));
  assert.equal(service.eligible, true);
  assert.ok(service.claims.some(({ contractKey }) => contractKey === "acme.UserService"));
  assert.ok(service.evidence.every(({ claimId, commitSha }) => claimId && commitSha));
});

test("selected service boundary excludes neighboring LLD and service claims and unrelated HLD paths", () => {
  const inventory = {
    repoId: 'github/acme/chain', commitSha: 'abc', complete: true,
    services: ['a', 'b', 'c', 'd'].map((id) => ({ id, evidence: ev(`${id}.go`) })),
    components: [{ id: 'c-worker', serviceId: 'c', evidence: ev('c-worker.go') }],
    dependencies: [
      { source: 'a', target: 'b', evidence: ev('a-to-b.go') },
      { source: 'b', target: 'c', evidence: ev('b-to-c.go') },
      { source: 'b', target: 'd', evidence: ev('b-to-d.go') },
      { source: 'c-worker', target: 'c', edgeKind: 'reads', evidence: ev('c-read.go') },
    ],
  };
  const graph = buildOrgGraph({ inventories: [inventory] });
  const anchor = 'github/acme/chain::service::d';
  const curriculum = selectCurriculum(graph, { learnerNodeIds: [anchor], maxDependencyHops: 2 });
  const lld = buildEvidencePack(graph, { scope: 'lld', curriculum });
  const service = buildEvidencePack(graph, { scope: 'service', curriculum });
  const hld = buildEvidencePack(graph, { scope: 'hld', curriculum, maxHops: 3 });
  assert.equal(lld.claims.length, 0);
  assert.ok(service.claims.length > 0);
  assert.ok(service.claims.every((edge) => [edge.sourceId, edge.targetId].includes(anchor)));
  assert.ok(hld.path_count > 0);
  assert.ok([...enumerateServicePaths(hld.path_universe)].every((path) => path.some((id) => { const edge = graph.edges.find((entry) => entry.id === id); return [edge.sourceId, edge.targetId].includes(anchor); })));

  const cAnchor = 'github/acme/chain::service::c';
  const cCurriculum = selectCurriculum(graph, { learnerNodeIds: [cAnchor], maxDependencyHops: 2 });
  const cLld = buildEvidencePack(graph, { scope: 'lld', curriculum: cCurriculum });
  const cService = buildEvidencePack(graph, { scope: 'service', curriculum: cCurriculum });
  assert.equal(cLld.eligible, true);
  assert.ok(cLld.claims.every((edge) => [edge.sourceId, edge.targetId].every((id) => id === cAnchor || id === 'github/acme/chain::component::c-worker')));
  assert.ok(cService.claims.every((edge) => [edge.sourceId, edge.targetId].includes(cAnchor)));
});

test("HLD requires and returns deterministic multi-hop service paths", () => {
  const worker = {
    repoId: "github/acme/jobs", commitSha: "ddd", complete: true,
    services: [{ id: "jobs", evidence: ev("main.py") }],
    dependencies: [{ source: "jobs", targetId: "github/acme/gateway::service::gateway", edgeKind: "calls", evidence: ev("client.py") }],
  };
  const graph = buildOrgGraph({ inventories: [...repos, worker] });
  const curriculum = selectCurriculum(graph, { learnerNodeIds: ["github/acme/jobs::service::jobs"], maxDependencyHops: 2 });
  const hld = buildEvidencePack(graph, { scope: "hld", curriculum, maxHops: 3 });
  assert.equal(hld.eligible, true);
  assert.ok([...enumerateServicePaths(hld.path_universe)].some((path) => path.length === 2));
  assert.ok(hld.claims.every(({ provenance }) => provenance !== "runtime"));
});

test("single service edge does not pretend to be an HLD flow", () => {
  const graph = buildOrgGraph({ inventories: repos });
  const curriculum = selectCurriculum(graph, { learnerNodeIds: ["github/acme/gateway::service::gateway"] });
  const hld = buildEvidencePack(graph, { scope: "hld", curriculum });
  assert.equal(hld.eligible, false);
  assert.deepEqual(hld.paths, []);
});

test("dangling targets and runtime observations are never quiz eligible", () => {
  const graph = buildOrgGraph({ inventories: [{
    repoId: "github/acme/a", commitSha: "abc", complete: true,
    services: [{ id: "a", evidence: ev("main.go") }],
    dependencies: [
      { source: "a", targetId: "github/acme/missing::service::missing", evidence: ev("client.go") },
      { source: "a", target: "a", provenance: "runtime", evidence: ev("trace.json") },
    ],
  }] });
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.every(({ quizEligible }) => !quizEligible));
  assert.equal(graph.edges.find(({ provenance }) => provenance === "runtime").resolution, "resolved");
});

test("canonical hashing streams the stable representation and enforces its byte budget", () => {
  const value = { z: [true, null, "λ"], a: { y: 2, x: 1 } };
  const canonical = '{"a":{"x":1,"y":2},"z":[true,null,"λ"]}';
  assert.equal(canonicalHash(value), createHash("sha256").update(canonical).digest("hex"));
  assert.equal(canonicalHash(value), canonicalHash({ a: { x: 1, y: 2 }, z: [true, null, "λ"] }));
  assert.throws(
    () => canonicalHash(value, { maxBytes: 8 }),
    (error) => error instanceof RangeError && error.code === "architecture_graph_hash_byte_limit" && error.maximum === 8,
  );
});

test("graph cardinality guardrails fail early with typed, inspectable errors", async (t) => {
  const inventory = {
    repoId: "guarded", commitSha: "abc", complete: true,
    services: [{ id: "service", evidence: ev("service.go") }],
    components: [{ id: "component", serviceId: "service", evidence: ev("component.go") }],
    dependencies: [{ source: "component", target: "service", evidence: ev("call.go") }],
  };
  const cases = [
    ["nodes", { maxNodes: 1 }, "architecture_graph_node_limit"],
    ["edges", { maxEdges: 0 }, "architecture_graph_edge_limit"],
    ["evidence", { maxEvidenceRefs: 2 }, "architecture_graph_evidence_limit"],
  ];
  for (const [name, limits, code] of cases) await t.test(name, () => {
    assert.throws(() => buildOrgGraph({ inventories: [inventory], limits }), (error) => error.code === code && error.actual > error.maximum);
  });
});

test("bounds endpoint evidence while retaining relationship, source, contract, and target proof", () => {
  const many = (prefix, count) => Array.from({ length: count }, (_, index) => ({ path: `${prefix}-${String(index).padStart(2, "0")}.go`, startLine: 1, endLine: 1, contentHash: `${prefix}:${index}` }));
  const graph = buildOrgGraph({ inventories: [
    {
      repoId: "consumer", commitSha: "aaa", complete: true,
      services: [{ id: "consumer", evidence: many("consumer-service", 20) }],
      components: [{ id: "caller", serviceId: "consumer", evidence: many("caller", 20) }],
      dependencies: [{ source: "caller", contractKind: "protobuf", contractKey: "acme.API", evidence: many("relationship", 20) }],
    },
    {
      repoId: "owner", commitSha: "bbb", complete: true,
      services: [{ id: "owner", evidence: many("owner-service", 20) }],
      components: [{ id: "server", serviceId: "owner", evidence: many("server", 20) }],
      contracts: [{ id: "api", kind: "protobuf", key: "acme.API", ownerId: "server", evidence: many("contract", 20) }],
    },
  ] });
  assert.ok(graph.nodes.filter(({ kind }) => kind === "component").every(({ evidence }) => evidence.length === ORG_GRAPH_LIMITS.maxComponentEvidenceRefs));
  assert.ok(graph.nodes.filter(({ kind }) => kind === "service").every(({ evidence }) => evidence.length === ORG_GRAPH_LIMITS.maxServiceEvidenceRefs));
  assert.equal(graph.nodes.find(({ kind }) => kind === "contract").evidence.length, ORG_GRAPH_LIMITS.maxContractEvidenceRefs);
  const edge = graph.edges[0];
  assert.ok(edge.evidence.length <= ORG_GRAPH_LIMITS.maxEdgeEvidenceRefs);
  assert.ok(edge.evidence.some(({ path }) => path.startsWith("relationship-")));
  assert.ok(edge.evidence.some(({ path }) => path.startsWith("caller-")));
  assert.ok(edge.evidence.some(({ path }) => path.startsWith("contract-")));
  assert.ok(edge.evidence.some(({ path }) => path.startsWith("server-")));
  assert.equal(edge.quizEligible, true);
});

test("graph and claim identities are deterministic under inventory and evidence permutations", () => {
  const permuted = structuredClone(repos).reverse().map((inventory) => ({
    ...inventory,
    services: [...(inventory.services ?? [])].reverse().map((item) => ({ ...item, evidence: [...item.evidence].reverse() })),
    components: [...(inventory.components ?? [])].reverse().map((item) => ({ ...item, evidence: [...item.evidence].reverse() })),
    contracts: [...(inventory.contracts ?? [])].reverse().map((item) => ({ ...item, evidence: [...item.evidence].reverse() })),
    dependencies: [...(inventory.dependencies ?? [])].reverse().map((item) => ({ ...item, evidence: [...item.evidence].reverse() })),
  }));
  const original = buildOrgGraph({ inventories: repos });
  const shuffled = buildOrgGraph({ inventories: permuted });
  assert.equal(shuffled.buildId, original.buildId);
  assert.deepEqual(shuffled.edges.map(({ id }) => id), original.edges.map(({ id }) => id));
});

test("otherwise identical claims at different source coordinates retain distinct identities", () => {
  const inventory = {
    repoId: "coordinates", commitSha: "abc", complete: true,
    services: [{ id: "service", evidence: ev("main.go") }],
    components: [{ id: "caller", serviceId: "service", evidence: ev("caller.go") }],
    dependencies: [
      { source: "caller", target: "service", evidence: ev("first.go") },
      { source: "caller", target: "service", evidence: ev("second.go") },
    ],
  };
  const graph = buildOrgGraph({ inventories: [inventory] });
  assert.equal(graph.edges.length, 2);
  assert.equal(new Set(graph.edges.map(({ id }) => id)).size, 2);
});

test("large directory-shaped inventories retain linear bounded evidence", () => {
  const dependencyCount = 2_000;
  const inventory = {
    repoId: "large", commitSha: "abc", complete: true,
    services: [{ id: "service", evidence: ev("main.go") }],
    components: [{ id: "wide-directory", serviceId: "service", evidence: Array.from({ length: 300 }, (_, index) => ev(`wide/file-${index}.go`)[0]) }],
    dependencies: Array.from({ length: dependencyCount }, (_, index) => ({ source: "wide-directory", target: "service", evidence: ev(`wide/file-${index}.go`) })),
  };
  const graph = buildOrgGraph({ inventories: [inventory] });
  assert.equal(graph.edges.length, dependencyCount);
  assert.equal(graph.nodes.find(({ kind }) => kind === "component").evidence.length, 1);
  assert.ok(graph.edges.every(({ evidence }) => evidence.length <= ORG_GRAPH_LIMITS.maxEdgeEvidenceRefs));
  assert.ok(graph.edges.reduce((count, edge) => count + edge.evidence.length, 0) <= dependencyCount * 3);
  const pack = buildEvidencePack(graph, { scope: "lld" });
  assert.equal(pack.eligible, true);
  assert.equal(pack.claims.length, dependencyCount);
  assert.ok(pack.evidence.length <= dependencyCount * ORG_GRAPH_LIMITS.maxEdgeEvidenceRefs);
  assert.match(graph.buildId, /^graph:[a-f0-9]{64}$/);
});

test("large service graphs retain every eligible claim and multi-hop path", () => {
  const serviceCount = 1_500;
  const services = Array.from({ length: serviceCount }, (_, index) => ({ id: `service-${index}`, evidence: ev(`services/${index}/main.go`) }));
  const dependencies = Array.from({ length: serviceCount - 1 }, (_, index) => ({
    source: `service-${index}`,
    target: `service-${index + 1}`,
    evidence: ev(`services/${index}/client.go`),
  }));
  const graph = buildOrgGraph({ inventories: [{ repoId: "fanout", commitSha: "abc", complete: true, services, dependencies }] });
  const service = buildEvidencePack(graph, { scope: "service" });
  const hld = buildEvidencePack(graph, { scope: "hld", maxHops: 3 });
  assert.equal(service.eligible, true);
  assert.equal(service.claims.length, dependencies.length);
  assert.equal(hld.eligible, true);
  assert.equal(hld.path_count, (serviceCount - 2) + (serviceCount - 3));
  assert.ok([...enumerateServicePaths(hld.path_universe)].every((path) => path.length >= 2 && path.length <= 3));
  assert.equal(hld.claims.length, dependencies.length);
});

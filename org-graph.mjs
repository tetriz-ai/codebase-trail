// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import { buildServicePathUniverse } from "./path-universe.mjs";
import { isArchitectureClaimQuizEligible } from "./architecture-governance.mjs";

export const ORG_GRAPH_LIMITS = Object.freeze({
  maxNodes: 50_000,
  maxEdges: 250_000,
  maxEvidenceRefs: 500_000,
  maxCanonicalHashBytes: 64 * 1024 * 1024,
  maxServiceEvidenceRefs: 8,
  maxComponentEvidenceRefs: 1,
  maxContractEvidenceRefs: 8,
  maxRelationshipEvidenceRefs: 4,
  maxEdgeEvidenceRefs: 8,
});

const limitError = (code, actual, maximum) => {
  const error = new RangeError(`${code}: ${actual} exceeds ${maximum}`);
  error.code = code;
  error.actual = actual;
  error.maximum = maximum;
  return error;
};

/** Hash canonical JSON without ever materializing the complete serialization. */
export function canonicalHash(value, { maxBytes = ORG_GRAPH_LIMITS.maxCanonicalHashBytes } = {}) {
  const digest = createHash("sha256");
  let bytes = 0;
  const write = (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) throw limitError("architecture_graph_hash_byte_limit", bytes, maxBytes);
    digest.update(chunk);
  };
  const visit = (current) => {
    if (Array.isArray(current)) {
      write("[");
      current.forEach((item, index) => { if (index) write(","); visit(item); });
      write("]");
      return;
    }
    if (current && typeof current === "object") {
      write("{");
      Object.keys(current).sort().forEach((key, index) => {
        if (index) write(",");
        write(JSON.stringify(key)); write(":"); visit(current[key]);
      });
      write("}");
      return;
    }
    write(JSON.stringify(current) ?? "null");
  };
  visit(value);
  return digest.digest("hex");
}

const hash = (value, limits) => canonicalHash(value, { maxBytes: limits?.maxCanonicalHashBytes ?? ORG_GRAPH_LIMITS.maxCanonicalHashBytes });

const immutable = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
};

const clean = (value, fallback = "unknown") => String(value ?? fallback).trim() || fallback;
const logicalId = (repoId, kind, localId) => `${repoId}::${kind}::${clean(localId)}`;
const occurrenceId = (logical, commitSha) => `${logical}@${commitSha}`;

const evidenceKey = (ref) => [ref.repoId, ref.commitSha, ref.path, ref.startLine, ref.endLine, ref.contentHash ?? ""].join("\u0000");
const boundedEvidence = (values, limit) => {
  const unique = new Map((values ?? []).map((ref) => [evidenceKey(ref), ref]));
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, limit).map(([, ref]) => ref);
};

const normalizeEvidence = (evidence, repoId, commitSha) => ({
  repoId,
  commitSha,
  path: clean(evidence?.path),
  startLine: Number(evidence?.startLine ?? evidence?.line ?? 1),
  endLine: Number(evidence?.endLine ?? evidence?.line ?? evidence?.startLine ?? 1),
  contentHash: evidence?.contentHash ?? null,
});

const normalizeInventory = (raw, limits) => {
  const repoId = clean(raw.repoId ?? raw.repository?.id);
  const commitSha = clean(raw.commitSha ?? raw.revision);
  const services = (raw.services ?? []).map((service) => {
    const localId = clean(service.id ?? service.name);
    const id = logicalId(repoId, "service", localId);
    return {
      id,
      occurrenceId: occurrenceId(id, commitSha),
      kind: "service",
      repoId,
      commitSha,
      localId,
      name: clean(service.name ?? localId),
      boundaryRole: service.boundaryRole ?? service.boundary_role ?? 'deployable',
      resolutionState: service.resolutionState ?? service.resolution_state ?? 'resolved',
      evidence: boundedEvidence((service.evidence ?? []).map((item) => normalizeEvidence(item, repoId, commitSha)), limits.maxServiceEvidenceRefs),
    };
  });
  const serviceByLocal = new Map(services.map((service) => [service.localId, service.id]));
  const components = (raw.components ?? []).map((component) => {
    const localId = clean(component.id ?? component.name);
    const serviceLocalId = clean(component.serviceId ?? component.service ?? "repository");
    const id = logicalId(repoId, "component", localId);
    return {
      id,
      occurrenceId: occurrenceId(id, commitSha),
      kind: "component",
      repoId,
      commitSha,
      localId,
      name: clean(component.name ?? localId),
      serviceId: serviceByLocal.get(serviceLocalId) ?? logicalId(repoId, "service", serviceLocalId),
      evidence: boundedEvidence((component.evidence ?? []).map((item) => normalizeEvidence(item, repoId, commitSha)), limits.maxComponentEvidenceRefs),
    };
  });
  const componentByLocal = new Map(components.map((component) => [component.localId, component.id]));
  const contracts = (raw.contracts ?? []).map((contract) => {
    const contractKey = clean(contract.key ?? contract.fqn ?? contract.package ?? contract.name);
    const ownerLocal = clean(contract.ownerId ?? contract.componentId ?? contract.serviceId);
    return {
      id: logicalId(repoId, "contract", contract.id ?? contractKey),
      occurrenceId: occurrenceId(logicalId(repoId, "contract", contract.id ?? contractKey), commitSha),
      kind: "contract",
      contractKind: clean(contract.kind ?? "contract"),
      contractKey,
      repoId,
      commitSha,
      ownerId: componentByLocal.get(ownerLocal) ?? serviceByLocal.get(ownerLocal) ?? logicalId(repoId, "service", ownerLocal),
      evidence: boundedEvidence((contract.evidence ?? []).map((item) => normalizeEvidence(item, repoId, commitSha)), limits.maxContractEvidenceRefs),
    };
  });
  return {
    repoId,
    commitSha,
    complete: raw.complete === true && raw.truncated !== true,
    diagnostics: [...(raw.diagnostics ?? [])],
    services: services.sort((a, b) => a.id.localeCompare(b.id)),
    components: components.sort((a, b) => a.id.localeCompare(b.id)),
    contracts: contracts.sort((a, b) => a.id.localeCompare(b.id)),
    dependencies: raw.dependencies ?? [],
    coverageOmissions: (raw.coverageOmissions ?? []).map((omission) => ({ ...omission, serviceId: serviceByLocal.get(clean(omission.serviceId)) ?? logicalId(repoId, 'service', clean(omission.serviceId)) })),
  };
};

const endpoint = (value, endpointByLocal) => {
  if (!value) return null;
  if (String(value).includes("::")) return String(value);
  return endpointByLocal.get(String(value)) ?? null;
};

const rawCardinality = (inventories) => {
  let nodes = 0; let edges = 0; let evidence = 0;
  for (const inventory of inventories) {
    const nodeGroups = [inventory.services ?? [], inventory.components ?? [], inventory.contracts ?? []];
    nodes += nodeGroups.reduce((count, group) => count + group.length, 0);
    edges += (inventory.dependencies ?? []).length;
    for (const group of nodeGroups) for (const item of group) evidence += (item.evidence ?? []).length;
    for (const dependency of inventory.dependencies ?? []) evidence += (dependency.evidence ?? []).length;
  }
  return { nodes, edges, evidence };
};

const assertCardinality = (counts, limits) => {
  if (counts.nodes > limits.maxNodes) throw limitError("architecture_graph_node_limit", counts.nodes, limits.maxNodes);
  if (counts.edges > limits.maxEdges) throw limitError("architecture_graph_edge_limit", counts.edges, limits.maxEdges);
  if (counts.evidence > limits.maxEvidenceRefs) throw limitError("architecture_graph_evidence_limit", counts.evidence, limits.maxEvidenceRefs);
};

/** Build an immutable, deterministic organization graph from plugin inventories. */
export function buildOrgGraph({ inventories = [], requiredRepoIds = [], limits: limitOverrides = {} } = {}) {
  const limits = { ...ORG_GRAPH_LIMITS, ...limitOverrides };
  assertCardinality(rawCardinality(inventories), limits);
  const normalized = inventories.map((inventory) => normalizeInventory(inventory, limits)).sort((a, b) => a.repoId.localeCompare(b.repoId));
  const revisions = Object.fromEntries(normalized.map(({ repoId, commitSha }) => [repoId, commitSha]));
  let diagnostics = [];
  const seenRepos = new Set(normalized.map(({ repoId }) => repoId));
  if (seenRepos.size !== normalized.length) diagnostics.push({ code: "duplicate_repository_snapshot", severity: "error" });
  for (const repoId of requiredRepoIds) {
    if (!seenRepos.has(repoId)) diagnostics.push({ code: "required_repo_missing", repoId, severity: "error" });
  }
  for (const inventory of normalized) {
    if (!inventory.complete) diagnostics.push({ code: "incomplete_repository_snapshot", repoId: inventory.repoId, severity: "error" });
    diagnostics.push(...inventory.diagnostics.map((detail) => ({ code: "extractor_diagnostic", repoId: inventory.repoId, detail })));
  }

  const nodes = normalized.flatMap((inventory) => [...inventory.services, ...inventory.components, ...inventory.contracts]);
  const incompleteBoundaryIds = [...new Set(normalized.flatMap((inventory) => inventory.coverageOmissions.map(({ serviceId }) => serviceId)))].sort();
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const contractOwners = new Map();
  for (const contract of nodes.filter((node) => node.kind === "contract")) {
    const key = `${contract.contractKind}:${contract.contractKey}`;
    const owners = contractOwners.get(key) ?? [];
    owners.push(contract);
    contractOwners.set(key, owners);
  }

  const edges = [];
  for (const inventory of normalized) {
    const endpointByLocal = new Map([...inventory.services, ...inventory.components].map((node) => [node.localId, node.id]));
    for (const dependency of inventory.dependencies) {
      const sourceId = endpoint(dependency.sourceId ?? dependency.source, endpointByLocal);
      let targetId = endpoint(dependency.targetId ?? dependency.target, endpointByLocal);
      if (targetId && !nodeIds.has(targetId)) targetId = null;
      let resolution = targetId ? "resolved" : "unresolved";
      const contractKind = clean(dependency.contractKind ?? dependency.kind ?? "contract");
      const contractKey = dependency.contractKey ?? dependency.contract ?? dependency.package;
      let candidates = [];
      if (!targetId && contractKey) {
        candidates = contractOwners.get(`${contractKind}:${clean(contractKey)}`) ?? [];
        if (candidates.length === 1) {
          targetId = nodeIds.has(candidates[0].ownerId) ? candidates[0].ownerId : null;
          resolution = targetId ? "resolved" : "unresolved";
        } else if (candidates.length > 1) {
          resolution = "ambiguous";
        }
      }
      const relationshipEvidence = boundedEvidence((dependency.evidence ?? []).map((item) => normalizeEvidence(item, inventory.repoId, inventory.commitSha)), limits.maxRelationshipEvidenceRefs);
      const targetNode = nodeById.get(targetId);
      const sourceNode = nodeById.get(sourceId);
      const resolvedContract = candidates.length === 1 ? candidates[0] : null;
      const evidence = boundedEvidence([
        ...relationshipEvidence,
        ...(sourceNode?.evidence ?? []).slice(0, 1),
        ...(resolvedContract?.evidence ?? []).slice(0, 2),
        ...(targetNode?.evidence ?? []).slice(0, 1),
      ], limits.maxEdgeEvidenceRefs);
      const provenance = clean(dependency.provenance ?? "code");
      const hasCompleteEvidence = relationshipEvidence.length > 0 && (sourceNode?.evidence?.length ?? 0) > 0 && (targetNode?.evidence?.length ?? 0) > 0 && evidence.every((ref) => ref.path !== "unknown"
        && ref.startLine > 0 && ref.endLine >= ref.startLine && ref.contentHash);
      const claim = {
        id: `claim:${hash({
          repoId: inventory.repoId,
          commitSha: inventory.commitSha,
          sourceId,
          targetId,
          kind: dependency.edgeKind ?? dependency.relationship ?? "depends_on",
          mechanism: dependency.mechanism ?? (contractKey ? "contract" : "static"),
          semanticStrength: dependency.semanticStrength ?? "declared_dependency",
          provenance,
          contractKind,
          contractKey: contractKey ? clean(contractKey) : null,
          relationshipEvidence,
        }, limits)}`,
        sourceId,
        targetId,
        kind: clean(dependency.edgeKind ?? dependency.relationship ?? "depends_on"),
        mechanism: clean(dependency.mechanism ?? (contractKey ? "contract" : "static")),
        semanticStrength: clean(dependency.semanticStrength ?? "declared_dependency"),
        provenance,
        resolution,
        quizEligible: false,
        contractKey: contractKey ? clean(contractKey) : null,
        candidateOwnerIds: candidates.map(({ ownerId }) => ownerId).sort(),
        endpointRepositoryIds: [...new Set([sourceId, targetId].map((id) => nodeById.get(id)?.repoId).filter(Boolean))].sort(),
        evidence,
      };
      claim.quizEligible = inventory.complete && hasCompleteEvidence && isArchitectureClaimQuizEligible(claim);
      const eligible = claim.quizEligible;
      edges.push(claim);
      if (!eligible) diagnostics.push({
        code: resolution === "ambiguous" ? "ambiguous_dependency" : "ineligible_dependency",
        repoId: inventory.repoId,
        claimId: claim.id,
        contractKey: claim.contractKey,
        candidateOwnerIds: claim.candidateOwnerIds,
        severity: "warning",
      });
    }
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  diagnostics = diagnostics.map((diagnostic) => ({ diagnostic, key: hash(diagnostic, limits) }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ diagnostic }) => diagnostic);
  const complete = diagnostics.every((item) => item.severity !== "error");
  const snapshots = normalized.map(({ repoId, commitSha, complete: snapshotComplete }) => ({
    snapshotId: `snapshot:${hash({ repoId, commitSha }, limits)}`,
    repoId,
    commitSha,
    complete: snapshotComplete,
  }));
  const finalEvidenceCount = nodes.reduce((count, node) => count + node.evidence.length, 0) + edges.reduce((count, edge) => count + edge.evidence.length, 0);
  if (finalEvidenceCount > limits.maxEvidenceRefs) throw limitError("architecture_graph_evidence_limit", finalEvidenceCount, limits.maxEvidenceRefs);
  // Hash the bounded graph as a Merkle-style list of record digests. A large,
  // but otherwise valid graph can exceed the per-value canonical hashing
  // budget when every record is serialized a second time as one giant value.
  // Individual record hashes retain the complete canonical content while the
  // final hash stays proportional to graph cardinality rather than evidence
  // text size.
  const nodeHashes = nodes.map((node) => hash(node, limits));
  const edgeHashes = edges.map((edge) => hash(edge, limits));
  const buildId = `graph:${hash({ revisions, nodeHashes, edgeHashes, incompleteBoundaryIds, complete }, limits)}`;
  return immutable({ buildId, revisions, snapshots, complete, nodes, edges, incompleteBoundaryIds, diagnostics });
}

const graphNodeIndexes = new WeakMap();
const graphServiceIndexes = new WeakMap();
const graphDeployableIndexes = new WeakMap();
const serviceOf = (nodeId, graph) => {
  let nodeById = graphNodeIndexes.get(graph);
  if (!nodeById) { nodeById = new Map(graph.nodes.map((node) => [node.id, node])); graphNodeIndexes.set(graph, nodeById); }
  let serviceByNodeId = graphServiceIndexes.get(graph);
  if (!serviceByNodeId) { serviceByNodeId = new Map(); graphServiceIndexes.set(graph, serviceByNodeId); }
  if (serviceByNodeId.has(nodeId)) return serviceByNodeId.get(nodeId);
  const visited = []; const seen = new Set(); let currentId = nodeId; let result = null;
  while (currentId && !seen.has(currentId)) {
    if (serviceByNodeId.has(currentId)) { result = serviceByNodeId.get(currentId); break; }
    seen.add(currentId); visited.push(currentId);
    const node = nodeById.get(currentId);
    if (!node) break;
    if (node.kind === "service") { result = node.resolutionState === 'resolved' && node.evidence.length > 0 ? node.id : null; break; }
    currentId = node.kind === "component" ? node.serviceId : node.kind === "contract" ? node.ownerId : null;
  }
  for (const id of visited) serviceByNodeId.set(id, result);
  return result;
};

export function selectCurriculum(graph, { learnerNodeIds = [], maxDependencyHops = 1 } = {}) {
  const anchors = new Set(learnerNodeIds.map((id) => serviceOf(id, graph) ?? id));
  const selected = new Set(anchors);
  let frontier = [...anchors];
  const eligible = graph.edges.filter((edge) => edge.quizEligible);
  for (let hop = 0; hop < maxDependencyHops; hop += 1) {
    const next = []; const frontierSet = new Set(frontier);
    for (const edge of eligible) {
      const source = serviceOf(edge.sourceId, graph);
      const target = serviceOf(edge.targetId, graph);
      if (frontierSet.has(source) && target && !selected.has(target)) next.push(target);
      if (frontierSet.has(target) && source && !selected.has(source)) next.push(source);
    }
    next.forEach((id) => selected.add(id));
    frontier = [...new Set(next)];
  }
  return immutable({ anchorServiceIds: [...anchors].sort(), serviceIds: [...selected].sort() });
}

const serviceEdges = (graph, allowed) => graph.edges.filter((edge) => {
  if (!edge.quizEligible) return false;
  const source = serviceOf(edge.sourceId, graph);
  const target = serviceOf(edge.targetId, graph);
  return source && target && allowed.has(source) && allowed.has(target);
});
const deployableService = (serviceId, graph) => {
  let deployable = graphDeployableIndexes.get(graph);
  if (!deployable) {
    deployable = new Set(graph.nodes.filter((node) => node.kind === 'service' && node.boundaryRole === 'deployable').map(({ id }) => id));
    graphDeployableIndexes.set(graph, deployable);
  }
  return deployable.has(serviceId);
};

/** Select only closed, deterministic evidence. HLD requires a multi-hop path. */
export function buildEvidencePack(graph, { scope, curriculum, maxHops = 3 } = {}) {
  if (!graph.complete) return immutable({ scope, eligible: false, reason: "incomplete_graph", claims: [], paths: [] });
  const allowed = new Set(curriculum?.serviceIds ?? graph.nodes.filter((node) => node.kind === "service").map(({ id }) => id));
  const anchors = new Set(curriculum?.anchorServiceIds ?? allowed);
  const incomplete = new Set(graph.incompleteBoundaryIds ?? []);
  let claims = serviceEdges(graph, allowed).filter((edge) => !incomplete.has(serviceOf(edge.sourceId, graph)) && !incomplete.has(serviceOf(edge.targetId, graph)));
  let pathUniverse;
  if (scope === "lld") {
    claims = claims.filter((edge) => serviceOf(edge.sourceId, graph) === serviceOf(edge.targetId, graph) && anchors.has(serviceOf(edge.sourceId, graph)));
  } else if (scope === "service") {
    claims = claims.filter((edge) => {
      const source = serviceOf(edge.sourceId, graph); const target = serviceOf(edge.targetId, graph);
      return source !== target && (anchors.has(source) || anchors.has(target)) && deployableService(source, graph) && deployableService(target, graph);
    });
  } else if (scope === "hld") {
    claims = claims.filter((edge) => {
      const source = serviceOf(edge.sourceId, graph); const target = serviceOf(edge.targetId, graph);
      return source !== target && deployableService(source, graph) && deployableService(target, graph);
    });
    pathUniverse = buildServicePathUniverse(claims.map((claim) => ({ ...claim, sourceServiceId: serviceOf(claim.sourceId, graph), targetServiceId: serviceOf(claim.targetId, graph) })), { maxHops, anchors: [...anchors] });
  } else {
    throw new Error(`Unsupported evidence scope: ${scope}`);
  }
  claims = claims.map((claim) => ({ ...claim, sourceServiceId: serviceOf(claim.sourceId, graph), targetServiceId: serviceOf(claim.targetId, graph) }));
  const evidence = claims.flatMap((claim) => claim.evidence.map((ref) => ({ claimId: claim.id, ...ref })));
  return immutable({
    scope,
    graphBuildId: graph.buildId,
    revisions: graph.revisions,
    eligible: claims.length > 0 && (scope !== "hld" || BigInt(pathUniverse.path_count) > 0n),
    claims,
    paths: [],
    path_count: pathUniverse?.path_count ?? 0,
    ...(pathUniverse ? { path_universe: pathUniverse } : {}),
    evidence,
  });
}

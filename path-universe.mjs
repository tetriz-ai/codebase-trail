// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
// Store service transitions and their evidence alternatives, rather than the
// Cartesian product of all possible paths. Counts and sampling use the same
// cycle-free traversal, including the selected-boundary constraint.
const MEMO_ENTRIES = 4_096;
const publicCount = (value) => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();

export function buildServicePathUniverse(claims, { maxHops = 3, anchors = [] } = {}) {
  if (!Number.isSafeInteger(maxHops) || maxHops < 2 || maxHops > 8) throw new RangeError('HLD hop depth must be between 2 and 8.');
  const nodes = [...new Set(claims.flatMap((claim) => [claim.sourceServiceId, claim.targetServiceId]))].sort();
  const nodeIds = new Map(nodes.map((id, index) => [id, index]));
  const grouped = nodes.map(() => new Map());
  for (const claim of claims) {
    const source = nodeIds.get(claim.sourceServiceId); const target = nodeIds.get(claim.targetServiceId);
    if (source === target) continue;
    if (!grouped[source].has(target)) grouped[source].set(target, []);
    grouped[source].get(target).push(claim.id);
  }
  const universe = {
    version: 1, max_hops: maxHops, nodes, anchor_required: anchors.length > 0,
    anchors: [...new Set(anchors.map((id) => nodeIds.get(id)).filter((id) => id !== undefined))],
    adjacency: grouped.map((targets) => [...targets].map(([target, claim_ids]) => ({ target, claim_ids }))),
  };
  const counter = pathCounter(universe);
  universe.path_count = publicCount(counter.total);
  return universe;
}

function pathCounter(universe) {
  const anchors = new Set(universe.anchors); const memo = new Map();
  const accepts = (visited) => visited.length >= 3 && (!universe.anchor_required || visited.some((node) => anchors.has(node)));
  const count = (current, visited) => {
    const depth = visited.length - 1;
    const stop = accepts(visited) ? 1n : 0n;
    if (depth >= universe.max_hops) return stop;
    const key = `${current}:${[...visited].sort((a, b) => a - b).join(',')}`;
    if (memo.has(key)) return memo.get(key);
    let total = stop;
    for (const step of universe.adjacency[current] || []) {
      if (visited.includes(step.target)) continue;
      total += BigInt(step.claim_ids.length) * count(step.target, [...visited, step.target]);
    }
    // This bounds computational memoization, without discarding any path.
    if (memo.size >= MEMO_ENTRIES) memo.delete(memo.keys().next().value);
    memo.set(key, total);
    return total;
  };
  const starts = universe.nodes.map((_, start) => count(start, [start]));
  return { count, accepts, starts, total: starts.reduce((total, value) => total + value, 0n) };
}

function randomRank(total, random) {
  // Multiple draws preserve access to every rank even above 2^53 paths.
  // Integer scaling avoids floating-point rounding of large path counts.
  const base = 1n << 53n; let span = 1n; let value = 0n;
  do { value = value * base + BigInt(Math.floor(random() * Number(base))); span *= base; } while (span < total);
  return value * total / span;
}

export function sampleServicePath(universe, { eligibleClaimIds, random = Math.random } = {}) {
  const available = eligibleClaimIds ? {
    ...universe,
    adjacency: universe.adjacency.map((steps) => steps.map((step) => ({
      ...step, claim_ids: step.claim_ids.filter((id) => eligibleClaimIds.has(id)),
    })).filter((step) => step.claim_ids.length)),
  } : universe;
  const counter = pathCounter(available);
  if (!counter.total) return null;
  let rank = randomRank(counter.total, random); let current = 0;
  for (; current < counter.starts.length; current += 1) {
    if (rank < counter.starts[current]) break;
    rank -= counter.starts[current];
  }
  const visited = [current]; const path = [];
  while (visited.length - 1 < available.max_hops) {
    if (counter.accepts(visited)) { if (rank === 0n) return path; rank -= 1n; }
    for (const step of available.adjacency[current] || []) {
      if (visited.includes(step.target)) continue;
      const suffixCount = counter.count(step.target, [...visited, step.target]);
      const weight = BigInt(step.claim_ids.length) * suffixCount;
      if (rank >= weight) { rank -= weight; continue; }
      path.push(step.claim_ids[Number(rank / suffixCount)]);
      rank %= suffixCount; current = step.target; visited.push(current); break;
    }
  }
  return path;
}

// Explicit iteration is for small graph inspection. Catalog and generation
// use counts and weighted sampling and never expand this iterator into arrays.
export function* enumerateServicePaths(universe) {
  const anchors = new Set(universe.anchors);
  function* visit(current, visited, trail) {
    if (trail.length >= 2 && (!universe.anchor_required || visited.some((node) => anchors.has(node)))) yield trail;
    if (trail.length >= universe.max_hops) return;
    for (const step of universe.adjacency[current] || []) {
      if (visited.includes(step.target)) continue;
      for (const id of step.claim_ids) yield* visit(step.target, [...visited, step.target], [...trail, id]);
    }
  }
  for (let start = 0; start < universe.nodes.length; start += 1) yield* visit(start, [start], []);
}

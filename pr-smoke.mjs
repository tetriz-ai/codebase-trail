// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { buildEvidenceBundle } from './server.mjs';
import { assertPrSmokeBundle } from './smoke-assertions.mjs';

const repository = process.env.CODE_LEARNING_GITHUB_REPOSITORY;
const args = process.argv.slice(2); const pullNumbers = args.filter((value) => !value.startsWith('--')).map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0);
const requireGraphComplete = args.includes('--require-graph-complete');
const minimumRelationships = Number(args.find((value) => value.startsWith('--min-relationships='))?.slice('--min-relationships='.length) ?? 0);
const expectedPaths = args.filter((value) => value.startsWith('--expect-path=')).map((value) => value.slice('--expect-path='.length));
const expectedQuestionTypes = args.filter((value) => value.startsWith('--expect-question-type=')).map((value) => value.slice('--expect-question-type='.length));
if (process.env.CODE_LEARNING_SOURCE_PROVIDER !== 'github-gh' || !repository || !pullNumbers.length) {
  throw new Error('Usage: CODE_LEARNING_SOURCE_PROVIDER=github-gh CODE_LEARNING_GITHUB_REPOSITORY=owner/repo npm run test:pr-smoke -- <merged-pr-number> [...]');
}
if (!Number.isSafeInteger(minimumRelationships) || minimumRelationships < 0) throw new Error('--min-relationships must be a non-negative integer.');

const summaries = [];
for (const pullNumber of pullNumbers) {
  const started = Date.now(); const bundle = await buildEvidenceBundle(pullNumber);
  const revision = assertPrSmokeBundle(bundle, pullNumber, { requireGraphComplete, minimumRelationships, expectedPaths, expectedQuestionTypes });
  summaries.push({
    repository, pull_number: pullNumber, revision,
    duration_ms: Date.now() - started,
    source_count: bundle.evidence_bundle.sources.length,
    source_kinds: Object.fromEntries([...new Set(bundle.evidence_bundle.sources.map(({ kind }) => kind))].sort().map((kind) => [kind, bundle.evidence_bundle.sources.filter((source) => source.kind === kind).length])),
    retrieved_paths: bundle.retrieval.retrieved_paths,
    exclusion_reasons: Object.fromEntries([...new Set(bundle.exclusions.map(({ reason }) => reason))].sort().map((reason) => [reason, bundle.exclusions.filter((entry) => entry.reason === reason).length])),
    graph_complete: bundle.retrieval.graph_complete,
    architecture_components: bundle.architecture_map.components.length,
    architecture_relationships: bundle.architecture_map.relationships.length,
    architecture_diagnostics: Object.fromEntries([...new Set(bundle.architecture_map.diagnostics.map(({ code }) => code))].sort().map((code) => [code, bundle.architecture_map.diagnostics.filter((diagnostic) => diagnostic.code === code).length])),
    allowed_question_types: bundle.allowed_question_types,
  });
}
console.log(JSON.stringify(summaries, null, 2));

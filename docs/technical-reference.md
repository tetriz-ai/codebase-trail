# Technical reference

Codebase Trail runs a local browser app backed by a loopback HTTP server. The launcher opens setup when no saved configuration exists and the learning app on later launches. `codebase-trail init` reopens setup.

Settings, credentials, canonical answer records, attempts, evidence pins and caches are stored in the user profile with restrictive file permissions where the platform supports them.

Full explanations remain in browser local storage and are available through History in that browser. Export them before clearing browser data or changing browsers. The server’s portable history export does not include full explanations.

## Sources and evidence

Architecture practice reads local Git revisions into a graph of files, manifests, imports, components and service relationships. PR practice reads GitHub pull requests through `gh` and bounds their metadata, patches, snapshots, manifests and adjacent source files. A question appears only after its citations, answer key, explanation and model review pass validation.

Ambiguous imports, incomplete snapshots, stale graph revisions, and unsupported relationships cannot support a published architecture claim. A source disclosure shows readable file coordinates without exposing internal graph identifiers.

Model prompts contain bounded evidence. The local history store rejects raw source, diffs, prompts and evidence bundles.

The selected model's source-egress policy matters. A remote API or signed-in Claude/Codex CLI sends bounded evidence to that provider.

Loopback endpoints can be declared local. External HTTP endpoints are rejected.

## Models

Settings supports OpenAI-compatible Chat Completions endpoints, OpenAI Responses, Anthropic Messages, Vertex AI generateContent, Claude Code CLI, and Codex CLI. The question writer and reviewer can use different models and providers.

OpenAI-compatible endpoints may advertise model IDs and completion limits through `/models`. Otherwise enter the exact ID and limits in Settings.

Install and sign in to a CLI provider separately. Settings offers Claude's `haiku`, `sonnet` and `opus` aliases and accepts `default` or an exact model ID for Codex. Both CLI outputs undergo JSON, citation and review validation.

Structured output, reasoning controls, token-limit field names and model access vary by provider and are negotiated where possible. Rejected model IDs, unavailable access, truncation and timeouts produce failures without publishing an unvalidated candidate. Generation requests at least 4,096 output tokens initially and may increase that allowance after truncation within the provider's limits.

## CLI help

`codebase-trail --help` prints command and setup requirements without starting the app. `codebase-trail start --help` and `codebase-trail init --help` print the same reference.

## Direct server mode

`node server.mjs` is a developer entry point without browser setup. It accepts the existing `CODE_LEARNING_*` configuration environment variables and `CODE_LEARNING_CONFIG` JSON file. The installed `codebase-trail` launcher instead uses saved Settings, with credential environment variables taking precedence over saved credential values.

A local OpenAI-compatible example:

```sh
CODE_LEARNING_MODEL_ENDPOINT=http://127.0.0.1:11434/v1 \
CODE_LEARNING_MODEL=your-model \
CODE_LEARNING_MODEL_AUTH_MODE=none \
node server.mjs
```

For a separate reviewer endpoint, set its provider, URL, credential policy, and source-egress policy explicitly. Generator credentials are not inherited across endpoints.

Native OpenAI and Anthropic transports use their official API bases by default. Vertex requires a publisher model collection URL and a current Google Cloud access token.

`CODEBASE_TRAIL_HOME` changes the launcher's settings directory. `CODEBASE_TRAIL_CONFIG` points it to another config file and `CODEBASE_TRAIL_NO_BROWSER=1` keeps it headless. The former `CODE_LEARNING_HOME`, `CODE_LEARNING_CONFIG`, and `CODE_LEARNING_NO_BROWSER` names remain accepted for existing installations.

## Deterministic architecture API

Local indexing defaults to 25,000 files, 256 MiB total source and 10 MiB per file. `ARCHITECTURE_MAX_FILES`, `ARCHITECTURE_MAX_BYTES` and `ARCHITECTURE_MAX_FILE_BYTES` configure those acquisition limits. Omitted files make the snapshot incomplete and can prevent questions.

Analysis also applies request ceilings across all snapshots: at most 20 repositories, with 25,000 files for server-acquired snapshots and their configured total-byte limit. Direct API submissions are limited to 5,000 files and 8 MiB of source content regardless of local indexing settings. Increasing acquisition limits does not raise the server-acquired analysis file ceiling.

`POST /api/architecture/analyze` accepts one or more revision-pinned repository snapshots. Each snapshot supplies a repository ID, revision, completeness status, and file records. The response contains service identities, typed dependency claims, a graph revision vector, and separate LLD, service, and HLD evidence packs.

`POST /api/architecture/generate` accepts the analysis snapshots plus `scope: "lld" | "service" | "hld"`. It materializes bounded excerpts, validates a structured candidate, reviews the answer and pins a published item to its evidence revision. Eligible evidence retains every claim and acyclic HLD path within the requested hop depth.

| Scope or rule | Generation behavior |
| --- | --- |
| LLD | Samples up to eight claims connected by component endpoints around a random anchor. |
| Service | Samples up to five claims connected by resolved service ownership around a random anchor. |
| HLD | Samples one complete path. Browser paths span two to four service edges. |
| Direction | Incoming and outgoing edges supply context while retaining their original direction. |
| Small neighborhoods | Remain small, without disconnected claims added to fill the prompt. |
| Retries and review | Keep the selected evidence fixed. |
| Selection IDs | Separate new questions in the cache and let prefetch share the same generation. |
| Runtime inference | Inferred edges do not qualify. |

| Term or field | Meaning |
| --- | --- |
| Claim | An eligible relationship grounded in source evidence. |
| Path | At least two ordered claims connecting services without revisiting a service. Parallel relationships can produce distinct evidence paths through the same services. |
| Counts | Measure extracted evidence, rather than architectural concepts or questions. Values above JavaScript's safe integer range are decimal strings. |
| HLD packs | Expose `path_count` and a compact `path_universe` transition index. `paths` stays empty until generation selects a path. |
| Sampling | Chooses directly from every eligible path without allocating combinations of parallel relationships. Only selected claims, their path and bounded excerpts reach the model. |
| Hop depth | The path index supports two to eight hops. |

- Prefetch and Generate share a selection ID and learning level.
- Cache hits and joined requests reserve no additional model capacity.
- New work waits in a bounded queue that prioritizes foreground work over prefetch.
- Changing scope or boundary cancels stale browser prefetches, and Cancel stops a matching warm-up.
- Cached questions retain version identifiers and policy hashes and restore public reproducibility fields on reload, without storing raw prompts or repository excerpts.

These local development APIs require the UI's capability token, a loopback Host, the matching Origin and JSON content type. Analysis makes no model call, while generation requires configured model access. Browser generation acquires source from configured checkouts and GitHub rather than trusting caller-supplied snapshots.

## Tests and diagnostics

```sh
npm test
npm run test:coverage
npx playwright install chromium
npm run test:browser
npm run test:install
npm run test:mutation
```

The checked-in fixtures exercise JavaScript/TypeScript, Go, Python, Java, Kotlin, Rust, Ruby, C#, Protobuf, SQL, Kubernetes, Compose, and Terraform extraction. The browser suite checks setup, dependency repair, question flow, history, feedback, and mobile layout. The install smoke test packs the project, installs it into a temporary directory, launches setup, and checks native parsers.

To check a source path without calling a model:

```sh
CODE_LEARNING_SOURCE_PROVIDER=github-gh \
CODE_LEARNING_GITHUB_REPOSITORY=owner/repository \
npm run test:pr-smoke -- 1234 --expect-question-type=mental_model
```

To check local architecture eligibility without calling a model:

```sh
npm run test:architecture-smoke -- \
  --require-scope=lld \
  owner/repository=/absolute/path/to/repository
```

The optional `npm run test:model-compat` command makes a tiny, source-free live request to a configured OpenRouter model. It is separate from the deterministic regression suite.


### Repository selection in direct server mode

The launcher normally supplies source settings. Direct `node server.mjs` users can set
`CODEBASE_TRAIL_REPOSITORY` to an `owner/repository` identifier and
`CODEBASE_TRAIL_CHECKOUT` to its local Git checkout. The earlier `CORE_REPO` and
`CORE_CHECKOUT` aliases remain supported; the neutral names take precedence.
`ARCHITECTURE_CHECKOUTS` accepts a JSON object mapping repository IDs to checkout
paths for analysis across multiple repositories. For example:

```sh
ARCHITECTURE_CHECKOUTS='{"example/api":"/path/to/api","example/worker":"/path/to/worker"}' node server.mjs
```

The browser uses `/api/architecture/practice/generate` and
`/api/architecture/practice/prefetch`. Their previous `/dogfood/` route aliases and
JavaScript exports remain supported for existing integrations.

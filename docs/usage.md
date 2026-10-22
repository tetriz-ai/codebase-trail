# Practice guide

Choose a repository and model once in Settings. The learning page’s What to learn dropdown switches between pull request, component, service and repository topology questions.

## Understand your question

Use a question to find one relationship you can explain from the source, then follow its references in your checkout.

| What you see | What it tells you | What to do next |
| --- | --- | --- |
| Question and answer choices | A component, service, repository path or merged PR relationship to reason about | Choose an answer before revealing the explanation |
| Explanation and source references | The model's reasoning and the committed evidence it cites | Open the references and check the relationship against the code |
| Foundational, Applied or Systems | The learning level selected for that question | Use it as context for the question, not a measured proficiency score |
| Coverage or indexing status | Whether the selected scope has enough supported evidence | Read the reported reason when generation cannot proceed |
| History, notes and feedback | Saved attempts you can review and export | Revisit a surprising relationship later; ratings and notes do not adapt generation |

Citation validation and model review are checks, not proof that an answer is correct. The [coverage guide](coverage.md) explains what the extractors can and cannot establish.

## Practice and development examples

Use the launch path printed by your installer, or repeat the [manual npx command](install.md#github-release-tarball) if you installed the tarball directly. The shell commands below run from this project's source checkout after `npm ci`. Choose the repository you want to practice in Settings.

### Architecture practice

When: you want to understand a local repository's components or service dependencies.

```sh
npm start
```

The first launch prints a local URL and opens setup in your browser.
Choose a checkout and model, save settings, and select LLD, service or HLD practice.
The engine randomly selects Foundational, Applied or Systems and shows the level on each question.

Remember:

- The app waits for the selected architecture index before enabling generation.
- Choose the model's source-egress policy in Settings before generating from private source.

If a question takes a long time, open **Preparation details** after it completes.
It shows time spent reading and analyzing the repository, creating the question and checking the answer, plus generation and review attempt counts.
Retries can add model calls; every published question still passes evidence validation and model review.
For a saved question, the app reports the cache reuse instead of showing its original model time as a new wait.
You can choose a different question model from the CLI presets or configure a separate reviewer in Settings.

### PR practice

When: you want to revisit a merged change you authored on GitHub.

```sh
npm start
```

Choose a checkout with a github.com remote, sign in to `gh`, and select PR practice.
Setup shows install or sign-in actions when GitHub access is missing.
Local architecture practice works without a GitHub account.

Remember:

- Discovery considers up to 50 merged PRs with changed files.
- Uncommitted and untracked source files are outside the committed snapshot.

### History

When: you want to revisit an answer, review its explanation or export your attempts.

In the running app, answer or reveal a question and open History.
Feedback is collapsed until you open it, and saving feedback updates the existing attempt.

For an offline demonstration with a synthetic checkout and fixed model responses, run:

```sh
node examples/revisit-an-answer/main.mjs
```

Remember:

- Answers help avoid repeats.
- An import rejected by validation leaves browser and durable history unchanged. Unrecoverable storage corruption is reported for repair.

If the connection fails, canonical answers may already be imported. Keep the import file and retry.

### Deterministic analysis

When: you want to inspect eligible source relationships without a model call.
This synthetic snapshot demonstrates deterministic analysis without calling a model. The session helper supplies local authentication.

Run the following block in a POSIX shell, such as bash or zsh. In Windows PowerShell, save the JavaScript between the `JS` markers as `analysis-example.mjs` in this checkout and run `node analysis-example.mjs` instead.

```sh
node --input-type=module <<'JS'
import { withExampleSession } from './scripts/example-session.mjs';
await withExampleSession(async (call) => {
  const repositories = [{ repository_id: 'example', revision: 'synthetic', tree_complete: true, files: [
    { path: 'package.json', content: '{"name":"example"}', complete: true },
    { path: 'a.js', content: 'import b from "./b.js"; export default b;\n', complete: true },
    { path: 'b.js', content: 'export default 1;\n', complete: true },
  ] }];
  const result = await call('/api/architecture/analyze', { repositories });
  console.log(`LLD eligible: ${result.scopes.lld.evidence_pack.eligible}`);
});
JS
```

```text
LLD eligible: true
```

### Contributor SDK

When: you are extending source extraction with an explicit convention.

```sh
node examples/register-extractor/main.mjs
```

The [complete example](../examples/register-extractor/) invokes the extractor contract.
For runtime registration, follow [the extractor workflow](../.claude/skills/add-extractor/SKILL.md).

Remember:

- Keep conventions explicit and test unrelated repository IDs.
- Preserve source coordinates and revision pins in discoveries and claims.

See the [technical reference](technical-reference.md) and [all examples](../examples/README.md).


## Model, evidence and storage reference

### Architecture analysis and generation

Analysis accepts one to twenty revision-pinned snapshots and returns eligible evidence packs without a model call.
Generation requires configured model access and returns a published item, rejection or abstention.
The [local API contract](technical-reference.md#deterministic-architecture-api) explains snapshot requirements, evidence limits and authentication.

### Models

| Transport | Requirements |
| --- | --- |
| OpenAI-compatible Chat Completions | An endpoint and its authentication policy |
| Native OpenAI Responses or Anthropic Messages | A provider credential and model access |
| Vertex AI generateContent | A publisher model collection URL and access token |
| Claude Code print mode or Codex exec mode | The CLI installed and authenticated locally |

Generation and review can use different providers and models.
Settings offers model presets and an editable model ID, checks available CLIs, and reports rejected or timed-out calls.
An API contract match does not guarantee access or structured output support for every model ID.

### Evidence and storage

A claim is an eligible source relationship, and a path is a directed sequence of at least two service relationships without revisiting a service.
Parallel relationships can create distinct paths through the same services.
The engine indexes eligible source relationships and samples connected evidence for each question.

Settings, credentials, canonical answer records, attempts, evidence pins and caches live in your user profile under Codebase Trail. Existing installations keep their earlier settings directory so saved settings and history remain discoverable.

API keys entered in Settings are saved as plaintext in the `credentials` object in `settings.json`, alongside the `config` object, in that profile directory. Older `config.json` and `credentials.json` files are read only as a fallback when `settings.json` is absent; saving Settings writes the combined `settings.json` file and does not delete those older files. The app restricts file permissions where supported, but does not encrypt keys or store them in the operating system keychain. Use a signed-in model CLI or provide credentials through environment variables if you do not want the app to save API keys.

Full question explanations remain in the current browser’s local storage. Use History in that browser to revisit them, and export before clearing browser data or changing browsers. The server’s portable history export contains canonical records, not full explanations.

History reads and writes coordinate through a lock beside the canonical history file, including across app processes and symlink aliases. An operation waits up to two seconds for the lock, then reports that storage is busy so you can retry. An interrupted process can leave a lock: stop every Codebase Trail process and confirm none owns the history file before manually removing only its `.lock` directory, preserving the history and backup files.

`CODEBASE_TRAIL_HOME` selects a different directory. `CODEBASE_TRAIL_CONFIG` selects a config file. `CODEBASE_TRAIL_NO_BROWSER=1` suppresses browser opening.

The `CODE_LEARNING_*` configuration names remain supported for direct `node server.mjs` development mode.
See [coverage and boundaries](coverage.md) for supported languages, declaration formats, hosting and operating systems.
The [technical reference](technical-reference.md) documents environment compatibility, APIs, caches and smoke commands.


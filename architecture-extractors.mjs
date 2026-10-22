// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parse as parseToml } from 'smol-toml';
import { analyzeJavaScriptSource, sourceImportEntries } from './syntax-analysis.mjs';
import { createRepositoryModuleIndex, resolveRepositoryModule } from './module-resolution.mjs';
import { EXTRACTOR_PLUGIN_API_VERSION, defineExtractorPlugin, extractorPluginManifest, runExtractorPlugin } from './plugin-sdk.mjs';

const PRECEDENCE = Object.freeze({ unresolved: 0, language_detector: 1, deployment_declaration: 2, maintainer_override: 3 });
const SOURCE_EXTENSIONS = new Set(['.go', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.kts', '.rs', '.rb', '.cs', '.proto', '.sql', '.tf']);

function lines(text = '') { return String(text).split(/\r?\n/); }
const fileContentHashes = new WeakMap();
function fileContentHash(file) {
  const content = String(file.content ?? ''); const cached = fileContentHashes.get(file);
  if (cached?.content === content) return cached.digest;
  const digest = createHash('sha256').update(content).digest('hex'); fileContentHashes.set(file, { content, digest });
  return digest;
}
function evidence(repository, file, line = 1) {
  return Object.freeze({ repository_id: repository.repository_id, revision: repository.revision, path: file.path, line_start: line, line_end: line, content_hash: fileContentHash(file) });
}
function item(kind, id, name, repository, file, extra = {}) {
  return { kind, logical_id: id, name, evidence: [evidence(repository, file, extra.line ?? 1)], ...extra, line: undefined };
}
function claim(kind, from, to, repository, file, line, extra = {}) {
  return { claim_kind: kind, from, to, provenance: extra.provenance ?? 'code_proven', semantic_strength: extra.semantic_strength ?? 'syntactic_reference', resolution_state: extra.resolution_state ?? 'unresolved', quiz_eligible: false, evidence: [evidence(repository, file, line)], resolver: extra.resolver ?? null };
}
function lineMatches(file, expression, visit) { lines(file.content).forEach((value, index) => { expression.lastIndex = 0; let match; while ((match = expression.exec(value))) visit(match, index + 1); }); }
function maskSyntax(content, { lineMarkers = [], blockComments = false, quotedStrings = false, quoteCharacters = ['"', "'", '`'] } = {}) {
  const source = String(content || ''); const output = source.split(''); let quote = null; let escaped = false;
  const blank = (index) => { if (source[index] !== '\n' && source[index] !== '\r') output[index] = ' '; };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (quotedStrings) blank(index);
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (quoteCharacters.includes(character)) { quote = character; if (quotedStrings) blank(index); continue; }
    const lineMarker = lineMarkers.find((marker) => source.startsWith(marker, index));
    if (lineMarker) {
      while (index < source.length && source[index] !== '\n') { blank(index); index += 1; }
      index -= 1; continue;
    }
    if (blockComments && source.startsWith('/*', index)) {
      blank(index); blank(index + 1); index += 2;
      while (index < source.length && !source.startsWith('*/', index)) { blank(index); index += 1; }
      if (index < source.length) { blank(index); blank(index + 1); index += 1; }
    }
  }
  return output.join('');
}
function withContent(file, content) { return { ...file, content }; }
function maskHeredocs(content) {
  const sourceLines = lines(content); let terminator = null;
  return sourceLines.map((value) => {
    if (terminator) { const done = value.trim() === terminator; const masked = value.replace(/[^\r\n]/g, ' '); if (done) terminator = null; return masked; }
    const marker = value.match(/<<-?\s*([A-Za-z_]\w*)\s*$/)?.[1];
    if (marker) terminator = marker;
    return value;
  }).join('\n');
}
function componentId(repositoryId, dir) { return `${repositoryId}:component:${dir || '.'}`; }
function serviceCandidate(repository, file, name, source, line = 1) { return { repository_id: repository.repository_id, candidate_name: name, source, precedence: PRECEDENCE[source], evidence: evidence(repository, file, line) }; }
const manifestRoot = (filePath) => path.posix.dirname(filePath) === '.' ? '.' : path.posix.dirname(filePath);
const projectId = (ecosystem, root) => `project:${ecosystem}:${root}`;
function projectDiscoveries(repository, file, ecosystem, name, ownershipPrecedence = 2) {
  const root = manifestRoot(file.path); const id = projectId(ecosystem, root);
  return [
    item('service', `${repository.repository_id}:${id}`, name, repository, file, { service_id: id, boundary_role: 'project', ownership_precedence: ownershipPrecedence }),
    item('component_ownership', `${repository.repository_id}:ownership:${ecosystem}:${root}`, name, repository, file, { component_path: root, service_id: id, ownership_precedence: ownershipPrecedence }),
    item('component', componentId(repository.repository_id, root), root, repository, file),
  ];
}
function projectReference(repository, file, targetRoot, resolver) {
  const root = manifestRoot(file.path); const normalized = path.posix.normalize(targetRoot || '.');
  return claim('project_reference', componentId(repository.repository_id, root), componentId(repository.repository_id, normalized), repository, file, 1, { semantic_strength: 'declared_dependency', resolver });
}
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false, parseTagValue: false, trimValues: true, isArray: (name) => ['ItemGroup', 'ProjectReference', 'module'].includes(name) });
const array = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const xmlText = (value) => typeof value === 'string' ? value : value?.['#text'] ?? null;
function xmlRoot(content, localName) {
  const validation = XMLValidator.validate(content); if (validation !== true) throw new Error(validation.err?.msg || 'Invalid XML');
  const parsed = xmlParser.parse(content); const key = Object.keys(parsed).find((candidate) => candidate.split(':').at(-1) === localName);
  return key ? parsed[key] : {};
}

const goPlugin = {
  id: 'go', version: '2-ast', supports: (file) => /(^|\/)go\.mod$|\.go$/.test(file.path),
  extract(file, repository) {
    const discoveries = [], claims = [], service_candidates = [];
    if (/(^|\/)go\.mod$/.test(file.path)) lineMatches(file, /^\s*module\s+(\S+)/g, (m, line) => { discoveries.push(item('contract', `${repository.repository_id}:go-module:${m[1]}`, m[1], repository, file, { line })); service_candidates.push(serviceCandidate(repository, file, m[1].split('/').at(-1), 'language_detector', line)); });
    if (/\.go$/.test(file.path)) {
      const from = componentId(repository.repository_id, path.posix.dirname(file.path));
      discoveries.push(item('component', from, path.posix.dirname(file.path), repository, file));
      const parsed = sourceImportEntries(file.path, file.content);
      for (const entry of parsed.entries) claims.push(claim('imports', from, `go-package:${entry.spec}`, repository, file, entry.line, { semantic_strength: 'syntactic_import', resolver: 'go_import' }));
      if (parsed.errors.length) return { discoveries, claims: [], service_candidates, diagnostics: [{ plugin: this.id, path: file.path, code: 'source_parse_error', severity: 'warning', blocking: false, details: parsed.errors }] };
    }
    return { discoveries, claims, service_candidates };
  },
};

const nodePlugin = {
  id: 'typescript-javascript', version: '4-lexical-scope', supports: (file) => /(^|\/)package\.json$|\.(?:[cm]?[jt]sx?)$/.test(file.path),
  extract(file, repository) {
    const discoveries = [], claims = [], service_candidates = [];
    if (/(^|\/)package\.json$/.test(file.path)) {
      try {
        const manifest = JSON.parse(file.content);
        if (manifest.name) {
          discoveries.push(item('contract', `${repository.repository_id}:npm-package:${manifest.name}`, manifest.name, repository, file));
          discoveries.push(...projectDiscoveries(repository, file, 'npm', manifest.name));
          if (manifestRoot(file.path) === '.') service_candidates.push(serviceCandidate(repository, file, manifest.name.replace(/^@[^/]+\//, ''), 'language_detector'));
        }
      } catch { return { discoveries, claims, service_candidates, diagnostics: [{ plugin: this.id, path: file.path, code: 'invalid_manifest' }] }; }
    } else {
      const from = componentId(repository.repository_id, path.posix.dirname(file.path)); discoveries.push(item('component', from, path.posix.dirname(file.path), repository, file));
      const analysis = analyzeJavaScriptSource(file.content, file.path);
      for (const entry of analysis.importsResult.entries) claims.push(claim('imports', from, `node-module:${entry.spec}`, repository, file, entry.line, { semantic_strength: 'syntactic_import', resolver: 'node_import' }));
      const bindings = analysis.bindingsResult.bindings;
      for (const handler of analysis.handlersResult.handlers) {
        const spec = bindings.get(handler.binding);
        if (spec) claims.push(claim('http_route_handler', from, `node-module:${spec}`, repository, file, handler.line, { semantic_strength: 'statically_bound_call', resolver: 'node_import' }));
      }
      if (analysis.importsResult.errors.length) return { discoveries, claims: [], service_candidates, diagnostics: [{ plugin: this.id, path: file.path, code: 'source_parse_error', severity: 'warning', blocking: false, details: analysis.importsResult.errors }] };
    }
    return { discoveries, claims, service_candidates };
  },
};

const pythonPlugin = {
  id: 'python', version: '2-ast', supports: (file) => /(^|\/)(?:pyproject\.toml|setup\.cfg|setup\.py)$|\.py$/.test(file.path),
  extract(file, repository) {
    const discoveries = [], claims = [], service_candidates = [];
    if (/pyproject\.toml$/.test(file.path)) lineMatches(file, /^\s*name\s*=\s*["']([^"']+)/g, (m, line) => service_candidates.push(serviceCandidate(repository, file, m[1], 'language_detector', line)));
    if (/\.py$/.test(file.path)) {
      const from = componentId(repository.repository_id, path.posix.dirname(file.path)); discoveries.push(item('component', from, path.posix.dirname(file.path), repository, file));
      const parsed = sourceImportEntries(file.path, file.content);
      for (const entry of parsed.entries) claims.push(claim('imports', from, `python-module:${entry.spec}`, repository, file, entry.line, { semantic_strength: 'syntactic_import', resolver: 'python_import' }));
      if (parsed.errors.length) return { discoveries, claims: [], service_candidates, diagnostics: [{ plugin: this.id, path: file.path, code: 'source_parse_error', severity: 'warning', blocking: false, details: parsed.errors }] };
    }
    return { discoveries, claims, service_candidates };
  },
};

function astImportPlugin({ id, extensions, resolver, exclude }) {
  const extensionPattern = new RegExp(`\\.(?:${extensions.join('|')})$`);
  return {
    id, version: '2-ast', supports: (file) => extensionPattern.test(file.path) && !exclude?.test(file.path),
    extract(file, repository) {
      const from = componentId(repository.repository_id, path.posix.dirname(file.path));
      const discoveries = [item('component', from, path.posix.dirname(file.path), repository, file)];
      const parsed = sourceImportEntries(file.path, file.content);
      const claims = parsed.errors.length ? [] : parsed.entries.map((entry) => claim('imports', from, `${resolver}:${entry.spec}`, repository, file, entry.line, { semantic_strength: 'syntactic_import', resolver }));
      const diagnostics = parsed.errors.length ? [{ plugin: id, path: file.path, code: 'source_parse_error', severity: 'warning', blocking: false, details: parsed.errors }] : [];
      return { discoveries, claims, diagnostics };
    },
  };
}

const javaPlugin = astImportPlugin({ id: 'java', extensions: ['java'], resolver: 'java_import' });
const kotlinPlugin = astImportPlugin({ id: 'kotlin', extensions: ['kt', 'kts'], resolver: 'kotlin_import', exclude: /(?:^|\/)(?:settings|build)\.gradle\.kts$/ });
const rustPlugin = astImportPlugin({ id: 'rust', extensions: ['rs'], resolver: 'rust_use' });
const rubyPlugin = astImportPlugin({ id: 'ruby', extensions: ['rb'], resolver: 'ruby_require' });
const csharpPlugin = astImportPlugin({ id: 'csharp', extensions: ['cs'], resolver: 'csharp_using' });

const workspaceManifestPlugin = {
  id: 'workspace-manifests', version: '2',
  supports: (file) => /(^|\/)(?:Cargo\.toml|pom\.xml|(?:settings|build)\.gradle(?:\.kts)?|[^/]+\.csproj|[^/]+\.slnx?)$/.test(file.path),
  extract(file, repository) {
    const discoveries = [], claims = [], diagnostics = []; const root = manifestRoot(file.path);
    try {
      if (/(^|\/)Cargo\.toml$/.test(file.path)) {
        const manifest = parseToml(file.content); const name = manifest.package?.name;
        if (typeof name === 'string' && name) discoveries.push(...projectDiscoveries(repository, file, 'cargo', name));
        if (manifest.workspace && typeof manifest.workspace === 'object') {
          discoveries.push(item('workspace', `${repository.repository_id}:workspace:cargo:${file.path}`, path.posix.basename(root), repository, file));
          for (const member of array(manifest.workspace.members).filter((value) => typeof value === 'string' && value && !/[*?[]/.test(value))) claims.push(projectReference(repository, file, path.posix.normalize(path.posix.join(root, member)), 'cargo_workspace_member'));
        }
        for (const section of [manifest.dependencies, manifest['dev-dependencies'], manifest['build-dependencies']]) for (const dependency of Object.values(section ?? {})) {
          if (!dependency || typeof dependency !== 'object' || typeof dependency.path !== 'string') continue;
          claims.push(projectReference(repository, file, path.posix.normalize(path.posix.join(root, dependency.path)), 'cargo_path_dependency'));
        }
        return { discoveries, claims };
      }
      if (/\.csproj$/.test(file.path)) {
        const project = xmlRoot(file.content, 'Project'); const name = xmlText(array(project.PropertyGroup).map((group) => group?.AssemblyName).find(Boolean)) || path.posix.basename(file.path, '.csproj');
        discoveries.push(...projectDiscoveries(repository, file, 'msbuild', name));
        for (const group of array(project.ItemGroup)) for (const reference of array(group?.ProjectReference)) {
          const include = reference?.['@_Include']; if (typeof include !== 'string') continue;
          claims.push(projectReference(repository, file, path.posix.dirname(path.posix.normalize(path.posix.join(root, include.replaceAll('\\', '/')))), 'msbuild_project_reference'));
        }
        return { discoveries, claims };
      }
      if (/\.slnx$/.test(file.path)) {
        const solution = xmlRoot(file.content, 'Solution');
        discoveries.push(item('workspace', `${repository.repository_id}:workspace:slnx:${file.path}`, path.posix.basename(file.path), repository, file));
        for (const project of array(solution.Project)) if (typeof project?.['@_Path'] === 'string') claims.push(projectReference(repository, file, path.posix.dirname(path.posix.normalize(path.posix.join(root, project['@_Path'].replaceAll('\\', '/')))), 'solution_project_reference'));
        return { discoveries, claims };
      }
      if (/\.sln$/.test(file.path)) {
        discoveries.push(item('workspace', `${repository.repository_id}:workspace:sln:${file.path}`, path.posix.basename(file.path), repository, file));
        lineMatches(file, /^Project\([^\n]+\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/g, (match) => {
          const target = path.posix.dirname(path.posix.normalize(path.posix.join(root, match[1].replaceAll('\\', '/'))));
          claims.push(projectReference(repository, file, target, 'solution_project_reference'));
        });
        return { discoveries, claims };
      }
      if (/(^|\/)pom\.xml$/.test(file.path)) {
        const project = xmlRoot(file.content, 'project'); const name = xmlText(project.artifactId) || path.posix.basename(root);
        discoveries.push(...projectDiscoveries(repository, file, 'maven', name));
        for (const moduleName of array(project.modules?.module).map(xmlText).filter(Boolean)) claims.push(projectReference(repository, file, path.posix.normalize(path.posix.join(root, moduleName)), 'maven_module'));
        return { discoveries, claims };
      }
      if (/(?:^|\/)(?:settings|build)\.gradle(?:\.kts)?$/.test(file.path)) {
        const parsedContent = maskSyntax(file.content, { lineMarkers: ['//'], blockComments: true });
        const configuredName = parsedContent.match(/\brootProject\.name\s*=\s*["']([^"']+)/)?.[1]; const name = configuredName || (root === '.' ? repository.repository_id.split('/').at(-1) : path.posix.basename(root));
        discoveries.push(...projectDiscoveries(repository, file, 'gradle', name, configuredName ? 4 : /settings\.gradle/.test(file.path) ? 3 : 1));
        if (/settings\.gradle/.test(file.path)) lineMatches(withContent(file, parsedContent), /\binclude\s*\(?([^\n]*)/g, (statement) => {
          for (const match of statement[1].matchAll(/["'](:?[^"']+)["']/g)) {
            const modulePath = match[1].replace(/^:/, '').replaceAll(':', '/'); if (modulePath) claims.push(projectReference(repository, file, path.posix.join(root, modulePath), 'gradle_project_reference'));
          }
        });
        return { discoveries, claims };
      }
    } catch (error) {
      diagnostics.push({ plugin: this.id, path: file.path, code: 'invalid_workspace_manifest', message: String(error.message).slice(0, 200) });
    }
    return { discoveries, claims, diagnostics };
  },
};

const protobufPlugin = {
  id: 'protobuf', version: '2', supports: (file) => /\.proto$/.test(file.path),
  extract(file, repository) {
    const parsedFile = withContent(file, maskSyntax(file.content, { lineMarkers: ['//'], blockComments: true }));
    const discoveries = [item('contract', `${repository.repository_id}:proto:${file.path}`, file.path, repository, file)], claims = [];
    lineMatches(parsedFile, /^\s*service\s+(\w+)/g, (m, line) => discoveries.push(item('service_contract', `${repository.repository_id}:proto-service:${m[1]}`, m[1], repository, file, { line })));
    lineMatches(parsedFile, /^\s*import\s+["']([^"']+)/g, (m, line) => claims.push(claim('imports_contract', `${repository.repository_id}:proto:${file.path}`, `proto:${m[1]}`, repository, file, line, { semantic_strength: 'declared_dependency', resolver: 'proto_path' })));
    lineMatches(parsedFile, /^\s*rpc\s+(\w+)\s*\(/g, (m, line) => discoveries.push(item('api', `${repository.repository_id}:rpc:${file.path}:${m[1]}`, m[1], repository, file, { line })));
    return { discoveries, claims };
  },
};

const sqlPlugin = {
  id: 'sql', version: '2', supports: (file) => /\.sql$/.test(file.path),
  extract(file, repository) {
    const discoveries = [], claims = []; const owner = componentId(repository.repository_id, path.posix.dirname(file.path));
    let parsed = maskSyntax(file.content, { lineMarkers: ['--'], blockComments: true });
    parsed = parsed.replace(/\$([A-Za-z_][\w]*)?\$[\s\S]*?\$\1\$/g, (value) => value.replace(/[^\r\n]/g, ' '));
    const parsedFile = withContent(file, maskSyntax(parsed, { quotedStrings: true, quoteCharacters: ["'"] }));
    lineMatches(parsedFile, /create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?([\w.]+)/ig, (m, line) => discoveries.push(item('datastore_resource', `${repository.repository_id}:table:${m[1]}`, m[1], repository, file, { line })));
    lineMatches(parsedFile, /references\s+["`]?([\w.]+)/ig, (m, line) => claims.push(claim('references_table', owner, `table:${m[1]}`, repository, file, line, { semantic_strength: 'declared_dependency', resolver: 'sql_table' })));
    return { discoveries, claims };
  },
};

function kubernetesExtract(file, repository) {
  const discoveries = [], service_candidates = [], diagnostics = [];
  const documents = String(file.content).split(/^---\s*$/m);
  let offset = 0;
  for (const document of documents) {
    const documentLines = lines(document); const kindIndex = documentLines.findIndex((value) => /^kind:\s*\S+/.test(value));
    if (kindIndex < 0) { offset += documentLines.length; continue; }
    const kind = documentLines[kindIndex].match(/^kind:\s*(\S+)/)?.[1];
    const metadataIndex = documentLines.findIndex((value) => /^metadata:\s*$/.test(value));
    let name = null; let nameIndex = -1;
    if (metadataIndex >= 0) for (let index = metadataIndex + 1; index < documentLines.length && !/^\S/.test(documentLines[index]); index += 1) {
      const match = documentLines[index].match(/^\s+name:\s*["']?([^\s"']+)/); if (match) { name = match[1]; nameIndex = index; break; }
    }
    if (!name) { diagnostics.push({ plugin: 'kubernetes-helm', path: file.path, code: 'resource_name_unresolved', line: offset + kindIndex + 1 }); offset += documentLines.length; continue; }
    if (/^(?:Service|Deployment|StatefulSet|DaemonSet|Job|CronJob)$/.test(kind)) {
      const line = offset + nameIndex + 1;
      discoveries.push(item(kind === 'Service' ? 'service_endpoint' : 'deployment', `${repository.repository_id}:k8s:${kind}:${name}`, name, repository, file, { line }));
      service_candidates.push(serviceCandidate(repository, file, name, 'deployment_declaration', line));
    }
    offset += documentLines.length;
  }
  return { discoveries, claims: [], service_candidates, diagnostics };
}

function composeExtract(file, repository) {
  const discoveries = [], claims = [], service_candidates = [], diagnostics = [];
  // A bounded block-mapping subset: ancestry, not matching indentation alone,
  // decides whether a dependency is a direct field of a service declaration.
  const stack = [{ indent: -1, path: [], mapping: true, children: new Set() }];
  const unresolved = (line) => diagnostics.push({ plugin: 'compose', path: file.path, code: 'compose_structure_unsupported', line });
  for (const [index, raw] of lines(file.content).entries()) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const indentation = raw.match(/^ */)[0].length;
    while (stack.length > 1 && indentation <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1);
    if (!parent.mapping) { if (parent.closed) unresolved(index + 1); continue; } // Scalar contents cannot contain YAML keys.
    if (/^ *\t/.test(raw) || parent.indent === -1 && indentation !== 0) { unresolved(index + 1); continue; }
    if (parent.childIndent !== undefined && indentation !== parent.childIndent) { unresolved(index + 1); continue; }
    parent.childIndent = indentation;
    const value = raw.trim().replace(/\s+#.*$/, '');
    const mapping = value.match(/^(?:([\w.-]+)|"([\w.-]+)"|'([\w.-]+)'):\s*(.*?)\s*(?:\s+#.*)?$/);
    const sequence = value.match(/^-\s+(?:([\w.-]+)|"([\w.-]+)"|'([\w.-]+)')\s*(?:#.*)?$/);
    const key = mapping?.[1] ?? mapping?.[2] ?? mapping?.[3];
    const rest = mapping?.[4] ?? '';
    const directDependencies = parent.path.length === 3 && parent.path[0] === 'services' && parent.path[2] === 'depends_on';
    if (directDependencies) {
      const collectionKind = mapping ? 'mapping' : sequence ? 'sequence' : 'unsupported';
      if (parent.collectionKind && parent.collectionKind !== collectionKind) unresolved(index + 1);
      parent.collectionKind = collectionKind;
      const dependencyName = key ?? sequence?.[1] ?? sequence?.[2] ?? sequence?.[3];
      if (!dependencyName || mapping && rest && rest !== '{}') { unresolved(index + 1); continue; }
      claims.push(claim('depends_on', `${repository.repository_id}:service:${parent.path[1]}`, `service:${dependencyName}`, repository, file, index + 1, { provenance: 'deployment_declared', semantic_strength: 'declared_dependency', resolver: 'compose_service' }));
    }
    if (!mapping) { if (parent.path.length <= 2 && parent.path[0] === 'services') unresolved(index + 1); continue; }
    if (parent.children.has(key)) { unresolved(index + 1); continue; }
    parent.children.add(key);
    const currentPath = [...parent.path, key];
    if (currentPath.length === 2 && currentPath[0] === 'services') {
      if (rest && rest !== '{}') { unresolved(index + 1); continue; }
      discoveries.push(item('service', `${repository.repository_id}:service:${key}`, key, repository, file, { line: index + 1 }));
      service_candidates.push(serviceCandidate(repository, file, key, 'deployment_declaration', index + 1));
    }
    if (currentPath.length === 3 && currentPath[0] === 'services' && key === 'depends_on' && rest) unresolved(index + 1);
    // Multiline quoted values have folding rules outside this subset. Abstain
    // for the file instead of interpreting later lines as declarations.
    if (/^["']/.test(rest) && !(rest.length >= 2 && rest.endsWith(rest[0]))) unresolved(index + 1);
    stack.push({ indent: indentation, path: currentPath, mapping: !rest, closed: rest.startsWith('[') || rest.startsWith('{'), children: new Set() });
  }
  if (!discoveries.length) diagnostics.push({ plugin: 'compose', path: file.path, code: 'compose_services_unresolved' });
  return { discoveries, claims: diagnostics.length ? [] : claims, service_candidates, diagnostics };
}
const isComposePath = (filePath) => /(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/.test(filePath);
const kubernetesHelmPlugin = { id: 'kubernetes-helm', version: '2', supports: (file) => !isComposePath(file.path) && /(?:^|\/)(?:charts?|k8s|kubernetes|deploy)\/.*\.ya?ml$|Chart\.yaml$|values\.ya?ml$/.test(file.path), extract: kubernetesExtract };
const composePlugin = { id: 'compose', version: '3', supports: (file) => isComposePath(file.path), extract: composeExtract };
const terraformPlugin = {
  id: 'terraform', version: '2', supports: (file) => /\.tf$/.test(file.path),
  extract(file, repository) {
    const discoveries = [], claims = []; const commentsRemoved = maskSyntax(file.content, { lineMarkers: ['//', '#'], blockComments: true });
    lineMatches(withContent(file, commentsRemoved), /^\s*(resource|data)\s+"([^"]+)"\s+"([^"]+)"/g, (m, line) => discoveries.push(item('infrastructure_resource', `${repository.repository_id}:terraform:${m[1]}:${m[2]}.${m[3]}`, `${m[2]}.${m[3]}`, repository, file, { line })));
    lineMatches(withContent(file, commentsRemoved), /^\s*module\s+"([^"]+)"/g, (m, line) => discoveries.push(item('infrastructure_resource', `${repository.repository_id}:terraform:module:${m[1]}`, m[1], repository, file, { line })));
    const references = withContent(file, maskSyntax(maskHeredocs(commentsRemoved), { quotedStrings: true }));
    lineMatches(references, /\b(module|data)\.([\w-]+)(?:\.([\w-]+))?/g, (m, line) => claims.push(claim('references_infrastructure', componentId(repository.repository_id, path.posix.dirname(file.path)), `terraform:${m[1]}:${m[2]}${m[3] ? `.${m[3]}` : ''}`, repository, file, line, { provenance: 'deployment_declared', semantic_strength: 'declared_dependency', resolver: 'terraform_address' })));
    return { discoveries, claims };
  },
};

/**
 * Discover service boundaries and component ownership from configured path patterns.
 * Each match carries declaration provenance and revision-pinned file evidence.
 */
export function createServiceBoundaryConventionPlugin({ id, boundaryPatterns = [], ownershipPatterns = [] }) {
  if (!id || !boundaryPatterns.length || !ownershipPatterns.length) throw new TypeError('A service-boundary convention requires an id, boundaryPatterns, and ownershipPatterns.');
  const matchService = (patterns, filePath) => {
    for (const pattern of patterns) { pattern.lastIndex = 0; const match = pattern.exec(filePath); if (match?.groups?.service || match?.[1]) return match.groups?.service || match[1]; }
    return null;
  };
  return defineExtractorPlugin({
    api_version: EXTRACTOR_PLUGIN_API_VERSION,
    id: `service-boundary:${id}`, version: '1', cache_scope: 'blob',
    cache_key: JSON.stringify({ boundaryPatterns: boundaryPatterns.map(String), ownershipPatterns: ownershipPatterns.map(String) }),
    capabilities: { languages: [], file_extensions: [], claim_kinds: ['service_boundary', 'component_ownership'] },
    supports: (file) => Boolean(matchService(boundaryPatterns, file.path) || matchService(ownershipPatterns, file.path)),
    extract(file, repository) {
      const discoveries = []; const boundary = matchService(boundaryPatterns, file.path); const owner = matchService(ownershipPatterns, file.path);
      if (boundary) discoveries.push(item('service', `${repository.repository_id}:service:${boundary}`, boundary, repository, file));
      if (owner) discoveries.push(item('component_ownership', `${repository.repository_id}:component-owner:${path.posix.dirname(file.path)}`, owner, repository, file, { component_path: path.posix.dirname(file.path), service_id: owner }));
      return { discoveries, claims: [] };
    },
  });
}

const PLUGIN_CAPABILITIES = Object.freeze({
  go: { languages: ['go'], file_extensions: ['.go'], claim_kinds: ['imports'] },
  'typescript-javascript': { languages: ['javascript', 'typescript'], file_extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'], claim_kinds: ['imports', 'http_route_handler'] },
  python: { languages: ['python'], file_extensions: ['.py'], claim_kinds: ['imports'] },
  java: { languages: ['java'], file_extensions: ['.java'], claim_kinds: ['imports'] },
  kotlin: { languages: ['kotlin'], file_extensions: ['.kt', '.kts'], claim_kinds: ['imports'] },
  rust: { languages: ['rust'], file_extensions: ['.rs'], claim_kinds: ['imports'] },
  ruby: { languages: ['ruby'], file_extensions: ['.rb'], claim_kinds: ['imports'] },
  csharp: { languages: ['csharp'], file_extensions: ['.cs'], claim_kinds: ['imports'] },
  'workspace-manifests': { languages: ['rust', 'csharp', 'java', 'kotlin'], file_extensions: ['.toml', '.xml', '.csproj', '.sln', '.slnx', '.gradle', '.kts'], claim_kinds: ['project_reference'] },
  protobuf: { languages: ['protobuf'], file_extensions: ['.proto'], claim_kinds: ['imports_contract'] },
  sql: { languages: ['sql'], file_extensions: ['.sql'], claim_kinds: ['references_table'] },
  'kubernetes-helm': { languages: ['yaml'], file_extensions: ['.yaml', '.yml'], claim_kinds: ['deployment'] },
  compose: { languages: ['yaml'], file_extensions: ['.yaml', '.yml'], claim_kinds: ['depends_on'] },
  terraform: { languages: ['terraform'], file_extensions: ['.tf'], claim_kinds: ['references_infrastructure'] },
});

function builtInPlugin(plugin) {
  return defineExtractorPlugin({ api_version: EXTRACTOR_PLUGIN_API_VERSION, cache_scope: 'blob', capabilities: PLUGIN_CAPABILITIES[plugin.id], ...plugin });
}

export const CORE_STACK_PLUGINS = Object.freeze([goPlugin, nodePlugin, pythonPlugin, javaPlugin, kotlinPlugin, rustPlugin, rubyPlugin, csharpPlugin, workspaceManifestPlugin, protobufPlugin, sqlPlugin, kubernetesHelmPlugin, composePlugin, terraformPlugin].map(builtInPlugin));

export function createExtractorRegistry(plugins = CORE_STACK_PLUGINS) {
  const validated = plugins.map(defineExtractorPlugin);
  const ids = new Set(); for (const plugin of validated) { if (ids.has(plugin.id)) throw new Error(`Duplicate extractor plugin: ${plugin.id}`); ids.add(plugin.id); }
  return Object.freeze({ plugins: Object.freeze(validated), versions: Object.freeze(Object.fromEntries(validated.map((plugin) => [plugin.id, plugin.version]))), manifest: extractorPluginManifest(validated) });
}

export function resolveServiceIdentities(candidates, overrides = []) {
  const all = [...candidates, ...overrides.map((override) => ({ ...override, source: 'maintainer_override', precedence: PRECEDENCE.maintainer_override }))]; const grouped = new Map();
  for (const candidate of all) { const values = grouped.get(candidate.repository_id) ?? []; values.push(candidate); grouped.set(candidate.repository_id, values); }
  return [...grouped].map(([repository_id, values]) => { const max = Math.max(...values.map((value) => value.precedence ?? PRECEDENCE[value.source] ?? 0)); const winners = values.filter((value) => (value.precedence ?? PRECEDENCE[value.source] ?? 0) === max); const names = [...new Set(winners.map((value) => value.candidate_name))]; return { repository_id, service_name: names.length === 1 ? names[0] : null, identity_source: names.length === 1 ? winners[0].source : 'unresolved', resolution_state: names.length === 1 ? 'resolved' : 'ambiguous', candidates: winners }; });
}

function dedupe(values, key) { const seen = new Set(); return values.filter((value) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true; }); }
export const ARCHITECTURE_EVIDENCE_LIMITS = Object.freeze({
  component: 1,
  service: 8,
  contract: 8,
  relationship: 4,
});

const evidenceKey = (ref) => JSON.stringify([
  ref?.repository_id ?? '', ref?.revision ?? '', ref?.path ?? '',
  ref?.line_start ?? ref?.startLine ?? 1, ref?.line_end ?? ref?.endLine ?? 1,
  ref?.content_hash ?? ref?.contentHash ?? '',
]);

function boundedEvidence(values, limit) {
  const byKey = new Map();
  for (const value of values ?? []) byKey.set(evidenceKey(value), value);
  return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, limit).map(([, value]) => value);
}

function retainBoundedEvidence(byKey, values, limit) {
  for (const value of values ?? []) byKey.set(evidenceKey(value), value);
  if (byKey.size <= limit) return;
  const retained = new Set([...byKey.keys()].sort().slice(0, limit));
  for (const key of byKey.keys()) if (!retained.has(key)) byKey.delete(key);
}

function mergeDiscoveries(values) {
  const merged = new Map();
  for (const value of values) {
    const limit = value.kind === 'component' ? ARCHITECTURE_EVIDENCE_LIMITS.component : ARCHITECTURE_EVIDENCE_LIMITS.contract;
    const current = merged.get(value.logical_id);
    if (!current) {
      const evidenceByKey = new Map(); retainBoundedEvidence(evidenceByKey, value.evidence, limit);
      merged.set(value.logical_id, { value: { ...value }, evidenceByKey, limit });
      continue;
    }
    retainBoundedEvidence(current.evidenceByKey, value.evidence, current.limit);
    const currentPrecedence = Number(current.value.ownership_precedence ?? 0); const candidatePrecedence = Number(value.ownership_precedence ?? 0);
    const currentKey = JSON.stringify([current.value.name, current.value.service_id, current.value.component_path]);
    const candidateKey = JSON.stringify([value.name, value.service_id, value.component_path]);
    if (candidatePrecedence > currentPrecedence || (candidatePrecedence === currentPrecedence && candidateKey.localeCompare(currentKey) < 0)) current.value = { ...value };
  }
  return [...merged.values()].map(({ value, evidenceByKey }) => ({
    ...value,
    evidence: [...evidenceByKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, ref]) => ref),
  }));
}

const pluginFingerprints = new WeakMap();
function pluginFingerprint(plugin) {
  let fingerprint = pluginFingerprints.get(plugin);
  if (!fingerprint) {
    fingerprint = createHash('sha256').update(JSON.stringify({
      api_version: plugin.api_version, id: plugin.id, version: plugin.version, capabilities: plugin.capabilities,
      cache_key: plugin.cache_key ?? null, supports: String(plugin.supports), extract: String(plugin.extract),
    })).digest('hex');
    pluginFingerprints.set(plugin, fingerprint);
  }
  return fingerprint;
}

const pick = (value, fields) => Object.fromEntries(fields.filter((field) => value?.[field] !== undefined).map((field) => [field, value[field]]));
const portableRef = (ref) => pick(ref, ['path', 'line_start', 'line_end', 'content_hash']);
const portableOutput = (output) => ({
  discoveries: (output.discoveries ?? []).map((entry) => ({ ...pick(entry, ['kind', 'logical_id', 'name', 'component_path', 'service_id', 'boundary_role', 'ownership_precedence']), evidence: (entry.evidence ?? []).map(portableRef) })),
  claims: (output.claims ?? []).map((entry) => ({ ...pick(entry, ['claim_kind', 'from', 'to', 'provenance', 'semantic_strength', 'resolution_state', 'quiz_eligible', 'resolver']), evidence: (entry.evidence ?? []).map(portableRef) })),
  service_candidates: (output.service_candidates ?? []).map((entry) => ({ ...pick(entry, ['candidate_name', 'source', 'precedence']), evidence: portableRef(entry.evidence) })),
});

function hydrateOutput(output, repository) {
  const hydrateRef = (ref) => {
    if (!ref || typeof ref.path !== 'string' || !Number.isInteger(ref.line_start) || !Number.isInteger(ref.line_end) || !/^[a-f0-9]{64}$/.test(ref.content_hash ?? '')) throw new Error('Invalid cached extractor evidence.');
    return { repository_id: repository.repository_id, revision: repository.revision, ...ref };
  };
  return {
    discoveries: (output.discoveries ?? []).map((entry) => ({ ...entry, evidence: (entry.evidence ?? []).map(hydrateRef) })),
    claims: (output.claims ?? []).map((entry) => ({ ...entry, evidence: (entry.evidence ?? []).map(hydrateRef) })),
    service_candidates: (output.service_candidates ?? []).map((entry) => ({ ...entry, repository_id: repository.repository_id, evidence: hydrateRef(entry.evidence) })),
  };
}

function blobCacheKey(plugin, repository, file) {
  return createHash('sha256').update(JSON.stringify([
    'architecture-blob-extraction-v1', pluginFingerprint(plugin), repository.repository_id, file.path, fileContentHash(file),
  ])).digest('hex');
}

export function extractArchitectureGraph({ repositories, overrides = [], registry = createExtractorRegistry(), blobCache = null }) {
  const discoveries = [], claims = [], diagnostics = [], candidates = []; let complete = true;
  for (const repository of repositories ?? []) {
    if (!repository.repository_id || !repository.revision || repository.tree_complete !== true) { complete = false; diagnostics.push({ repository_id: repository.repository_id, code: 'repository_tree_incomplete' }); }
    for (const omission of repository.omissions ?? []) diagnostics.push({ repository_id: repository.repository_id, ...omission, code: omission.reason || 'repository_file_omitted' });
    for (const file of repository.files ?? []) {
      const applicable = registry.plugins.filter((plugin) => plugin.supports(file));
      if (applicable.length && (file.complete === false || file.truncated === true || typeof file.content !== 'string')) { complete = false; diagnostics.push({ repository_id: repository.repository_id, path: file.path, code: 'required_blob_incomplete' }); continue; }
      for (const plugin of applicable) {
        try {
          const cacheable = blobCache && plugin.cache_scope === 'blob'; const key = cacheable ? blobCacheKey(plugin, repository, file) : null;
          let output;
          if (cacheable) {
            const cached = blobCache.get(key);
            if (cached) { try { output = hydrateOutput(portableOutput(cached), repository); } catch { output = undefined; } }
          }
          if (!output) {
            output = runExtractorPlugin(plugin, file, repository);
            if (cacheable && !(output.diagnostics ?? []).length) blobCache.set(key, portableOutput(output));
          }
          const pluginDiagnostics = output.diagnostics ?? [];
          discoveries.push(...(output.discoveries ?? [])); claims.push(...(output.claims ?? [])); candidates.push(...(output.service_candidates ?? []));
          diagnostics.push(...pluginDiagnostics.map((detail) => ({ repository_id: repository.repository_id, ...detail })));
          if (pluginDiagnostics.some((detail) => detail.blocking !== false)) complete = false;
        } catch (error) { complete = false; diagnostics.push({ repository_id: repository.repository_id, path: file.path, plugin: plugin.id, code: 'extractor_failed', message: error.message }); }
      }
    }
  }
  for (const repository of repositories ?? []) {
    const moduleIndex = createRepositoryModuleIndex(repository.files || []);
    for (const entry of claims.filter((candidate) => candidate.evidence?.[0]?.repository_id === repository.repository_id)) {
      const sourcePath = entry.evidence[0].path;
      const languages = { node_import: ['node', 'node-module:'], python_import: ['python', 'python-module:'], java_import: ['java', 'java_import:'], kotlin_import: ['kotlin', 'kotlin_import:'], rust_use: ['rust', 'rust_use:'], ruby_require: ['ruby', 'ruby_require:'], csharp_using: ['csharp', 'csharp_using:'] };
      const [language, prefix] = languages[entry.resolver] || [];
      if (!prefix || !entry.to?.startsWith(prefix)) continue;
      const targetPath = resolveRepositoryModule(moduleIndex, sourcePath, entry.to.slice(prefix.length), language);
      if (targetPath) { entry.to = componentId(repository.repository_id, path.posix.dirname(targetPath)); entry.resolution_state = 'unique'; }
    }
  }
  const services = resolveServiceIdentities(candidates, overrides);
  for (const repository of repositories ?? []) if (!services.some((service) => service.repository_id === repository.repository_id)) services.push({ repository_id: repository.repository_id, service_name: null, identity_source: 'unresolved', resolution_state: 'unresolved', candidates: [] });
  void blobCache?.flush()?.catch(() => { /* Extraction remains correct when its disposable cache cannot be written. */ });
  return Object.freeze({ schema_version: 'architecture-extraction-v1', extractor_versions: registry.versions, extractor_manifest: registry.manifest, completeness: complete ? 'complete' : 'incomplete', services, discoveries: mergeDiscoveries(discoveries), claims: dedupe(claims, (value) => JSON.stringify([value.claim_kind, value.from, value.to, value.evidence[0]])), diagnostics });
}

export function recognizedArchitecturePath(filePath) { return SOURCE_EXTENSIONS.has(path.posix.extname(filePath)) || CORE_STACK_PLUGINS.some((plugin) => plugin.supports({ path: filePath })); }

function inventoryEvidence(ref) { return { path: ref.path, startLine: ref.line_start, endLine: ref.line_end, contentHash: ref.content_hash }; }
function localComponentId(repositoryId, logicalId, evidencePath) {
  const prefix = `${repositoryId}:component:`;
  return logicalId?.startsWith(prefix) ? logicalId.slice(prefix.length) : path.posix.dirname(evidencePath);
}

// Module basenames are display labels, not identities: unrelated modules such
// as github.com/acme/api and github.com/acquired/api may coexist in one repo.
// Include both the module root and full declared path in the stable local ID.
function goModuleService(module) {
  const root = module.directory || '.';
  return { id: `go-module:${root}:${module.name}`, name: module.name.split('/').at(-1) };
}

/** Adapt extractor output to the stable inventory contract consumed by buildOrgGraph. */
export function toOrgInventory(repository, extraction) {
  const repositoryId = repository.repository_id;
  const service = extraction.services.find(({ repository_id }) => repository_id === repositoryId);
  const serviceId = service?.resolution_state === 'resolved' ? service.service_name : 'repository';
  const relevant = (value) => value.evidence?.some(({ repository_id }) => repository_id === repositoryId);
  const goModules = extraction.discoveries.filter((entry) => entry.logical_id.includes(':go-module:') && relevant(entry)).map((entry) => ({ name: entry.name, directory: path.posix.dirname(entry.evidence[0].path) === '.' ? '' : path.posix.dirname(entry.evidence[0].path), evidence: entry.evidence }));
  const declaredServices = [
    ...extraction.discoveries.filter((entry) => entry.kind === 'service' && relevant(entry)).map((entry) => ({ id: entry.service_id || entry.name, name: entry.name, boundaryRole: entry.boundary_role || 'deployable', resolutionState: 'resolved', evidence: boundedEvidence(entry.evidence, ARCHITECTURE_EVIDENCE_LIMITS.service).map(inventoryEvidence) })),
    ...(service?.candidates ?? []).filter((candidate) => candidate.source === 'deployment_declaration' && candidate.evidence?.repository_id === repositoryId).map((candidate) => ({ id: candidate.candidate_name, name: candidate.candidate_name, boundaryRole: 'deployable', resolutionState: 'resolved', evidence: [inventoryEvidence(candidate.evidence)] })),
    ...goModules.map((module) => ({ ...goModuleService(module), boundaryRole: 'project', resolutionState: 'resolved', evidence: boundedEvidence(module.evidence, ARCHITECTURE_EVIDENCE_LIMITS.service).map(inventoryEvidence) })),
  ];
  const services = dedupe(declaredServices, ({ id }) => id);
  if (service?.resolution_state === 'resolved' && !services.some(({ id }) => id === serviceId)) services.push({ id: serviceId, name: serviceId, boundaryRole: service.identity_source === 'deployment_declaration' ? 'deployable' : 'project', resolutionState: 'resolved', evidence: boundedEvidence(service.candidates.flatMap((candidate) => candidate.evidence ? [candidate.evidence] : []), ARCHITECTURE_EVIDENCE_LIMITS.service).map(inventoryEvidence) });
  const componentServiceId = services.length === 1 ? services[0].id : serviceId;
  const ownershipCandidates = new Map();
  for (const entry of extraction.discoveries.filter((candidate) => candidate.kind === 'component_ownership' && relevant(candidate))) {
    const candidates = ownershipCandidates.get(entry.component_path) ?? new Set(); candidates.add(entry.service_id); ownershipCandidates.set(entry.component_path, candidates);
  }
  const ownership = new Map([...ownershipCandidates].filter(([, candidates]) => candidates.size === 1).map(([componentPath, candidates]) => [componentPath, [...candidates][0]]));
  const ownershipDiagnostics = [...ownershipCandidates].filter(([, candidates]) => candidates.size > 1).map(([componentPath, candidates]) => ({ code: 'ambiguous_component_ownership', path: componentPath, service_ids: [...candidates].sort() }));
  const ambiguousOwnershipPaths = new Set(ownershipDiagnostics.map(({ path: componentPath }) => componentPath));
  const goModulesBySpecificity = [...goModules].sort((a, b) => b.directory.length - a.directory.length);
  const goModuleForPath = (filePath) => goModulesBySpecificity.find((candidate) => !candidate.directory || filePath === candidate.directory || filePath.startsWith(`${candidate.directory}/`));
  const serviceForPath = (filePath) => {
    let directory = filePath;
    while (directory && directory !== '.') {
      if (ambiguousOwnershipPaths.has(directory)) return 'repository';
      if (ownership.has(directory)) return ownership.get(directory);
      const parent = path.posix.dirname(directory); if (parent === directory) break; directory = parent;
    }
    if (ambiguousOwnershipPaths.has('.')) return 'repository';
    if (ownership.has('.')) return ownership.get('.');
    const module = goModuleForPath(filePath);
    return module ? goModuleService(module).id : componentServiceId;
  };
  const components = extraction.discoveries.filter((entry) => entry.kind === 'component' && relevant(entry)).map((entry) => ({ id: localComponentId(repositoryId, entry.logical_id, entry.evidence[0].path), name: entry.name, serviceId: serviceForPath(entry.evidence[0].path), evidence: boundedEvidence(entry.evidence, ARCHITECTURE_EVIDENCE_LIMITS.component).map(inventoryEvidence) }));
  const componentById = new Map(components.map((component) => [component.id, component]));
  const ensureComponent = (filePath, refs = []) => {
    const id = path.posix.dirname(filePath);
    if (!componentById.has(id)) {
      const component = { id, name: id, serviceId: serviceForPath(filePath), evidence: boundedEvidence(refs, ARCHITECTURE_EVIDENCE_LIMITS.component).map(inventoryEvidence) };
      components.push(component); componentById.set(id, component);
    }
    // One declaration proves component identity. Copying every originating
    // import into it makes every edge repeat an ever-growing evidence array.
    return id;
  };
  const contracts = extraction.discoveries.filter((entry) => ['contract', 'service_contract', 'api'].includes(entry.kind) && relevant(entry)).map((entry) => {
    const ref = entry.evidence[0]; const ownerId = ensureComponent(ref.path, entry.evidence); let kind = entry.kind; let key = entry.name;
    if (entry.logical_id.includes(':proto:')) { kind = 'protobuf'; key = entry.name; }
    if (entry.kind === 'service_contract') kind = 'protobuf_service';
    return { id: entry.logical_id, kind, key, ownerId, evidence: boundedEvidence(entry.evidence, ARCHITECTURE_EVIDENCE_LIMITS.contract).map(inventoryEvidence) };
  });
  for (const component of components.filter(({ evidence: refs }) => refs.length)) {
    const filePath = component.evidence[0].path; const goModule = goModuleForPath(filePath);
    if (!goModule) continue;
    const relative = goModule.directory ? component.id.slice(goModule.directory.length).replace(/^\//, '') : component.id;
    const packageKey = !relative || relative === '.' ? goModule.name : `${goModule.name}/${relative}`;
    contracts.push({ id: `${repositoryId}:go-package:${packageKey}`, kind: 'go_package', key: packageKey, ownerId: component.id, evidence: boundedEvidence([...component.evidence, ...goModule.evidence.map(inventoryEvidence)], ARCHITECTURE_EVIDENCE_LIMITS.contract) });
  }
  const dependencies = extraction.claims.filter(relevant).map((entry) => {
    const ref = entry.evidence[0]; const source = entry.from?.startsWith(`${repositoryId}:service:`) ? entry.from.split(':service:')[1] : ensureComponent(ref.path, entry.evidence);
    const result = { source, edgeKind: entry.claim_kind, mechanism: entry.resolver, semanticStrength: entry.semantic_strength, provenance: entry.provenance, evidence: boundedEvidence(entry.evidence, ARCHITECTURE_EVIDENCE_LIMITS.relationship).map(inventoryEvidence) };
    if (entry.to?.startsWith('proto:')) { result.contractKind = 'protobuf'; result.contractKey = entry.to.slice('proto:'.length); }
    else if (entry.to?.startsWith('service:')) result.target = entry.to.slice('service:'.length);
    else if (entry.to?.startsWith(`${repositoryId}:component:`)) result.target = entry.to.slice(`${repositoryId}:component:`.length);
    else if (entry.resolver === 'go_import') { result.contractKind = 'go_package'; result.contractKey = entry.to.slice('go-package:'.length); }
    else { result.contractKind = entry.resolver ?? entry.claim_kind; result.contractKey = entry.to; }
    return result;
  });
  const coverageOmissions = extraction.diagnostics.filter((detail) => detail.code === 'source_parse_error' && detail.path && (!detail.repository_id || detail.repository_id === repositoryId)).map((detail) => ({ path: detail.path, serviceId: serviceForPath(detail.path), code: detail.code }));
  if (components.length && !services.some(({ id }) => id === componentServiceId)) services.push({ id: componentServiceId, name: componentServiceId, boundaryRole: 'repository', resolutionState: service?.resolution_state || 'unresolved', evidence: [] });
  for (const missingServiceId of new Set(components.map(({ serviceId: id }) => id).filter((id) => !services.some((serviceEntry) => serviceEntry.id === id)))) services.push({ id: missingServiceId, name: missingServiceId, boundaryRole: 'repository', resolutionState: 'unresolved', evidence: [] });
  return { repoId: repositoryId, commitSha: repository.revision, complete: extraction.completeness === 'complete', services, components, contracts, dependencies, coverageOmissions, diagnostics: [...extraction.diagnostics.filter((detail) => !detail.repository_id || detail.repository_id === repositoryId), ...ownershipDiagnostics] };
}

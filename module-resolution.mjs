// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import path from 'node:path';

const NODE_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']);
const NODE_INDEX_FILES = Object.freeze(NODE_EXTENSIONS.map((extension) => `index${extension}`));

function addIndexValue(index, key, value) {
  const values = index.get(key) ?? [];
  values.push(value);
  index.set(key, values);
}

export function createRepositoryModuleIndex(files = []) {
  const byPath = new Map(files.map((file) => [typeof file === 'string' ? file : file.path, typeof file === 'string' ? null : file]));
  const paths = new Set(byPath.keys());
  const pythonModules = new Map();
  const nodePackages = [];
  const nodePackageByName = new Map();
  const cargoRoots = [];
  const csharpNamespaces = new Map();
  const csharpNamespacePrefixes = new Map();
  const javaModules = new Map();
  const kotlinModules = new Map();
  const rubyModules = new Map();
  for (const filePath of paths) {
    const file = byPath.get(filePath); const content = typeof file?.content === 'string' ? file.content : null;
    if (filePath.endsWith('package.json') && content) {
      try {
        const manifest = JSON.parse(content); const name = typeof manifest.name === 'string' ? manifest.name : null;
        if (name) {
          const entry = { name, manifestPath: filePath, root: path.posix.dirname(filePath) };
          nodePackages.push(entry); addIndexValue(nodePackageByName, name, entry);
        }
      } catch { /* Invalid manifests are diagnosed by the extractor. */ }
    }
    if (/(^|\/)Cargo\.toml$/.test(filePath)) cargoRoots.push(path.posix.dirname(filePath));
    if (filePath.endsWith('.cs') && content) {
      const namespace = content.match(/\bnamespace\s+([A-Za-z_][\w.]*)\s*(?:[;{])/m)?.[1];
      if (namespace) {
        addIndexValue(csharpNamespaces, namespace, filePath);
        const segments = namespace.split('.');
        for (let length = 1; length <= segments.length; length += 1) addIndexValue(csharpNamespacePrefixes, segments.slice(0, length).join('.'), filePath);
      }
    }
    const extension = path.posix.extname(filePath); const stem = filePath.slice(0, -extension.length); const pathSegments = stem.split('/');
    if (extension === '.java') for (let index = 0; index < pathSegments.length; index += 1) addIndexValue(javaModules, pathSegments.slice(index).join('.'), filePath);
    if (['.kt', '.kts', '.java'].includes(extension)) for (let index = 0; index < pathSegments.length; index += 1) addIndexValue(kotlinModules, pathSegments.slice(index).join('.'), filePath);
    if (extension === '.rb') for (let index = 0; index < pathSegments.length; index += 1) addIndexValue(rubyModules, pathSegments.slice(index).join('/'), filePath);
    if (!filePath.endsWith('.py')) continue;
    const modulePath = filePath.endsWith('/__init__.py') ? path.posix.dirname(filePath) : filePath.slice(0, -3);
    const segments = modulePath.split('/');
    for (let index = 0; index < segments.length; index += 1) addIndexValue(pythonModules, segments.slice(index).join('/'), filePath);
  }
  return { paths, pythonModules, nodePackages, nodePackageByName, cargoRoots, csharpNamespaces, csharpNamespacePrefixes, javaModules, kotlinModules, rubyModules };
}

export function resolveNodeModule(moduleIndex, sourcePath, spec) {
  if (!spec.startsWith('.')) {
    const names = [...(moduleIndex.nodePackageByName?.keys() ?? [])].filter((name) => spec === name || spec.startsWith(`${name}/`)).sort((a, b) => b.length - a.length);
    const matches = names.length ? (moduleIndex.nodePackageByName.get(names[0]) ?? []) : [];
    if (!matches.length || (matches.length > 1 && matches[0].name.length === matches[1].name.length)) return null;
    const selected = matches[0]; const subpath = spec.slice(selected.name.length).replace(/^\//, '');
    if (!subpath) return selected.manifestPath;
    const stem = path.posix.join(selected.root, subpath);
    const candidates = [stem, ...NODE_EXTENSIONS.map((extension) => `${stem}${extension}`), ...NODE_INDEX_FILES.map((name) => `${stem}/${name}`)].filter((candidate) => moduleIndex.paths.has(candidate));
    return candidates.length === 1 ? candidates[0] : null;
  }
  const stem = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), spec));
  const candidates = [stem, ...NODE_EXTENSIONS.map((extension) => `${stem}${extension}`), ...NODE_INDEX_FILES.map((name) => `${stem}/${name}`)]
    .filter((candidate) => moduleIndex.paths.has(candidate));
  return candidates.length === 1 ? candidates[0] : null;
}

export function resolvePythonModule(moduleIndex, sourcePath, spec) {
  if (spec.startsWith('.')) {
    const dots = spec.match(/^\.+/)[0].length;
    const tail = spec.slice(dots).replaceAll('.', '/');
    const stem = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), ...Array(Math.max(0, dots - 1)).fill('..'), tail));
    const candidates = [`${stem}.py`, `${stem}/__init__.py`].filter((candidate) => moduleIndex.paths.has(candidate));
    return candidates.length === 1 ? candidates[0] : null;
  }
  const candidates = moduleIndex.pythonModules.get(spec.replaceAll('.', '/')) ?? [];
  return candidates.length === 1 ? candidates[0] : null;
}

export function resolveJavaFamilyModule(moduleIndex, spec, extensions = ['.java', '.kt', '.kts']) {
  if (!spec || spec.endsWith('.*')) return null;
  const index = extensions.length === 1 && extensions[0] === '.java' ? moduleIndex.javaModules : moduleIndex.kotlinModules;
  const candidates = index?.get(spec) ?? [];
  return candidates.length === 1 ? candidates[0] : null;
}

export function resolveRubyModule(moduleIndex, sourcePath, spec) {
  const stem = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), spec)) : spec;
  const direct = [`${stem}.rb`, `${stem}/init.rb`].filter((candidate) => moduleIndex.paths.has(candidate));
  const candidates = [...direct, ...(!spec.startsWith('.') ? (moduleIndex.rubyModules?.get(stem) ?? []) : [])];
  return [...new Set(candidates)].length === 1 ? [...new Set(candidates)][0] : null;
}

export function resolveRustModule(moduleIndex, sourcePath, spec) {
  const roots = (moduleIndex.cargoRoots ?? []).filter((root) => root === '.' || sourcePath.startsWith(`${root}/`)).sort((a, b) => b.length - a.length);
  const root = roots[0] ?? '.';
  const sourceRoot = root === '.' ? 'src' : `${root}/src`;
  const relativeSource = sourcePath.startsWith(`${sourceRoot}/`) ? sourcePath.slice(sourceRoot.length + 1) : '';
  const sourceSegments = relativeSource.split('/').filter(Boolean); const file = sourceSegments.pop() ?? '';
  const currentModule = /^(?:lib|main)\.rs$/.test(file) ? sourceSegments : file === 'mod.rs' ? sourceSegments : [...sourceSegments, file.replace(/\.rs$/, '')];
  const raw = spec.split('::').filter(Boolean); let base = [];
  if (raw[0] === 'crate') raw.shift();
  else if (raw[0] === 'self') { raw.shift(); base = [...currentModule]; }
  else if (raw[0] === 'super') {
    base = [...currentModule];
    while (raw[0] === 'super') { raw.shift(); base.pop(); }
  }
  const segments = [...base, ...raw];
  for (let length = segments.length; length > 0; length -= 1) {
    const stem = segments.slice(0, length).join('/');
    const candidates = [`${sourceRoot}/${stem}.rs`, `${sourceRoot}/${stem}/mod.rs`].filter((candidate) => moduleIndex.paths.has(candidate));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return null;
  }
  return null;
}

export function resolveCsharpModule(moduleIndex, spec) {
  const paths = moduleIndex.csharpNamespacePrefixes?.get(spec) ?? []; const directories = [...new Set(paths.map((filePath) => path.posix.dirname(filePath)))];
  if (directories.length !== 1) return null;
  return paths.sort()[0] ?? null;
}

export function resolveRepositoryModule(moduleIndex, sourcePath, spec, language) {
  if (language === 'node') return resolveNodeModule(moduleIndex, sourcePath, spec);
  if (language === 'python') return resolvePythonModule(moduleIndex, sourcePath, spec);
  if (language === 'java') return resolveJavaFamilyModule(moduleIndex, spec, ['.java']);
  if (language === 'kotlin') return resolveJavaFamilyModule(moduleIndex, spec, ['.kt', '.kts', '.java']);
  if (language === 'ruby') return resolveRubyModule(moduleIndex, sourcePath, spec);
  if (language === 'rust') return resolveRustModule(moduleIndex, sourcePath, spec);
  if (language === 'csharp') return resolveCsharpModule(moduleIndex, spec);
  return null;
}

export const moduleResolutionPolicy = Object.freeze({ nodeExtensions: NODE_EXTENSIONS, nodeIndexFiles: NODE_INDEX_FILES });

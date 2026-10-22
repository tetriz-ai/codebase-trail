// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { Lang, parse, registerDynamicLanguage } from '@ast-grep/napi';
import go from '@ast-grep/lang-go';
import python from '@ast-grep/lang-python';
import java from '@ast-grep/lang-java';
import kotlin from '@ast-grep/lang-kotlin';
import rust from '@ast-grep/lang-rust';
import ruby from '@ast-grep/lang-ruby';
import csharp from '@ast-grep/lang-csharp';

registerDynamicLanguage({ go, python, java, kotlin, rust, ruby, csharp });

const extensionLanguage = (filePath) => {
  if (/\.(?:js|mjs|cjs)$/.test(filePath)) return Lang.JavaScript;
  if (/\.(?:ts|mts|cts)$/.test(filePath)) return Lang.TypeScript;
  if (/\.(?:tsx|jsx)$/.test(filePath)) return Lang.Tsx;
  if (/\.go$/.test(filePath)) return 'go';
  if (/\.py$/.test(filePath)) return 'python';
  if (/\.java$/.test(filePath)) return 'java';
  if (/\.kts?$/.test(filePath)) return 'kotlin';
  if (/\.rs$/.test(filePath)) return 'rust';
  if (/\.rb$/.test(filePath)) return 'ruby';
  if (/\.cs$/.test(filePath)) return 'csharp';
  return null;
};

const nodeIndexes = new WeakMap();
const nodes = (root, kind) => {
  let index = nodeIndexes.get(root);
  if (!index) { index = new Map(); nodeIndexes.set(root, index); }
  if (!index.has(kind)) index.set(kind, root.findAll({ rule: { kind } }));
  return index.get(kind);
};
const firstNode = (root, kinds) => {
  for (const kind of kinds) {
    const found = nodes(root, kind)[0];
    if (found) return found;
  }
  return null;
};
const unquote = (value) => String(value || '').replace(/^["'`]|["'`]$/g, '');

// Decode literal syntax only; computed module expressions remain unsupported.
function javascriptString(node) {
  const value = node.text().slice(1, -1);
  return value.replace(/\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\s\S]))/g, (escape, braced, unicode, hex, octal, character) => {
    if (braced || unicode || hex) {
      const codePoint = Number.parseInt(braced || unicode || hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
    }
    if (octal) return String.fromCharCode(Number.parseInt(octal, 8));
    if (/^[\r\n\u2028\u2029]/.test(character)) return '';
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[character] ?? character;
  });
}

export function parseSource(filePath, content) {
  const language = extensionLanguage(filePath);
  if (!language) return null;
  const root = parse(language, String(content || '')).root();
  const errors = [];
  for (const node of nodes(root, 'ERROR')) {
    const range = node.range(); const text = node.text(); const kind = node.kind();
    const knownParserArtifact = kind === 'ERROR' && (
      (/\.tsx$/.test(filePath) && ['jsx_element', 'string'].includes(node.parent()?.kind()) && /^&(?:\s|[A-Za-z][\w-]*=)/.test(text))
      || (/\.(?:tsx?|mts|cts)$/.test(filePath) && /^import\s*\(\s*["'][^"']+["']\s*\)\s*\./.test(text)
        && node.ancestors().some((ancestor) => /type/.test(ancestor.kind())))
    );
    if (kind === 'ERROR' && !knownParserArtifact) errors.push({ line: range.start.line + 1, text: text.slice(0, 120), kind: 'error_node' });
  }
  for (const node of root.findAll({ rule: { regex: '^$' } })) {
    const range = node.range(); const kind = node.kind();
    // Tree-sitter represents missing punctuation as an unnamed zero-width
    // leaf. Named zero-width nodes (for example an empty Go raw string body)
    // are valid grammar nodes and must not fail the repository closed.
    if (kind && range.start.index === range.end.index && !node.isNamed()) errors.push({ line: range.start.line + 1, text: kind, kind: 'missing_token' });
  }
  return { root, errors };
}

const identifierName = (node) => node.text().replace(/\\u(?:\{([\da-f]+)\}|([\da-f]{4}))/gi, (escape, braced, fixed) => {
  const codePoint = Number.parseInt(braced || fixed, 16);
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : escape;
});

function bindsRequire(node) {
  if (!node) return false;
  const kind = node.kind();
  if (['identifier', 'type_identifier', 'shorthand_property_identifier_pattern'].includes(kind)) return identifierName(node) === 'require';
  if (kind === 'pair_pattern') return bindsRequire(node.field('value'));
  if (['assignment_pattern', 'object_assignment_pattern'].includes(kind)) return bindsRequire(node.field('left'));
  if (['required_parameter', 'optional_parameter'].includes(kind)) return bindsRequire(node.field('pattern'));
  if (['object_pattern', 'array_pattern', 'rest_pattern', 'formal_parameters'].includes(kind)) return node.children().some(bindsRequire);
  return false;
}

function requireBindingScopes(root) {
  const scopes = [];
  const declarations = new Map();
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!declarations.has(node.kind())) declarations.set(node.kind(), []);
    declarations.get(node.kind()).push(node);
    pending.push(...node.children());
  }
  const ofKind = (kind) => declarations.get(kind) || [];
  const functionKinds = new Set(['function_declaration', 'generator_function_declaration', 'function_expression', 'generator_function', 'arrow_function', 'method_definition']);
  const blockKinds = new Set(['program', 'statement_block', 'switch_body', 'for_statement', 'for_in_statement', 'catch_clause', 'class_static_block']);
  const add = (node) => { const range = node.range(); scopes.push([range.start.index, range.end.index]); };
  const enclosing = (node, functionScoped = false) => {
    for (const ancestor of node.ancestors()) {
      const kind = ancestor.kind();
      if (functionScoped && functionKinds.has(kind)) return ancestor.field('body') || ancestor;
      if (kind === 'program' || kind === 'class_static_block' || !functionScoped && blockKinds.has(kind)) return ancestor;
    }
    return root;
  };
  for (const node of ofKind('variable_declarator')) {
    if (bindsRequire(node.field('name'))) add(enclosing(node, node.parent()?.kind() === 'variable_declaration'));
  }
  for (const kind of ['function_declaration', 'generator_function_declaration', 'class_declaration', 'enum_declaration', 'internal_module']) {
    for (const node of ofKind(kind)) if (bindsRequire(node.field('name'))) add(enclosing(node, kind.includes('function')));
  }
  for (const kind of ['function_expression', 'generator_function', 'class']) {
    for (const node of ofKind(kind)) if (bindsRequire(node.field('name'))) add(node);
  }
  for (const node of ofKind('for_in_statement')) {
    if (bindsRequire(node.field('left'))) add(node.children().some((child) => child.kind() === 'var') ? enclosing(node, true) : node);
  }
  for (const node of ofKind('formal_parameters')) if (bindsRequire(node)) add(node.parent() || root);
  for (const node of ofKind('arrow_function')) if (bindsRequire(node.field('parameter'))) add(node);
  for (const node of ofKind('catch_clause')) if (bindsRequire(node.field('parameter'))) add(node);
  for (const kind of ['import_alias', 'import_require_clause']) {
    for (const node of ofKind(kind)) if (bindsRequire(node.children().find((child) => child.isNamed()))) add(enclosing(node));
  }
  for (const clause of nodes(root, 'import_clause')) {
    if (/^import\s+type\b/.test(clause.parent()?.text() || '')) continue;
    if (clause.children().some(bindsRequire)
      || nodes(clause, 'namespace_import').some((node) => node.children().some(bindsRequire))
      || nodes(clause, 'import_specifier').some((node) => !/^type\s/.test(node.text()) && bindsRequire(node.field('alias') || node.field('name')))) add(enclosing(clause));
  }
  const merged = [];
  for (const [start, end] of scopes.sort((left, right) => left[0] - right[0])) {
    if (merged.length && start <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], end);
    else merged.push([start, end]);
  }
  return (index) => {
    let low = 0; let high = merged.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const [start, end] = merged[middle];
      if (index < start) high = middle - 1;
      else if (index >= end) low = middle + 1;
      else return true;
    }
    return false;
  };
}

function javascriptImports(root) {
  const entries = [];
  for (const statement of nodes(root, 'import_statement')) {
    const source = firstNode(statement, ['string']);
    if (source) entries.push({ spec: javascriptString(source), line: statement.range().start.line + 1 });
  }
  for (const statement of nodes(root, 'export_statement')) {
    const source = statement.field('source');
    if (source?.kind() === 'string') entries.push({ spec: javascriptString(source), line: statement.range().start.line + 1 });
  }
  const requireScopes = requireBindingScopes(root);
  for (const call of nodes(root, 'call_expression')) {
    const callee = call.field('function')?.text();
    const index = call.range().start.index;
    if (!['require', 'import'].includes(callee) || callee === 'require' && requireScopes(index)) continue;
    const source = call.field('arguments')?.children().find((node) => node.isNamed() && node.kind() !== 'comment');
    if (source?.kind() === 'string') entries.push({ spec: javascriptString(source), line: call.range().start.line + 1 });
  }
  return entries;
}

function goImports(root) {
  return nodes(root, 'import_spec').flatMap((entry) => {
    const source = firstNode(entry, ['interpreted_string_literal', 'raw_string_literal']);
    return source ? [{ spec: unquote(source.text()), line: entry.range().start.line + 1 }] : [];
  });
}

function pythonImports(root) {
  const entries = [];
  for (const statement of nodes(root, 'import_from_statement')) {
    const source = firstNode(statement, ['relative_import', 'dotted_name']);
    if (source) {
      const spec = source.text();
      if (/^\.+$/.test(spec)) {
        const imported = statement.text().match(/^\s*from\s+\.+\s+import\s+([A-Za-z_]\w*)/s)?.[1];
        entries.push({ spec: imported ? `${spec}${imported}` : spec, line: statement.range().start.line + 1 });
      } else entries.push({ spec, line: statement.range().start.line + 1 });
    }
  }
  for (const statement of nodes(root, 'import_statement')) {
    const imports = statement.children().filter((node) => ['dotted_name', 'aliased_import'].includes(node.kind()));
    for (const imported of imports) {
      const source = imported.kind() === 'aliased_import' ? firstNode(imported, ['dotted_name']) : imported;
      if (source) entries.push({ spec: source.text(), line: statement.range().start.line + 1 });
    }
  }
  return entries;
}

function declarationImports(root, declarationKind, sourceKinds) {
  return nodes(root, declarationKind).flatMap((statement) => {
    const source = firstNode(statement, sourceKinds);
    return source ? [{ spec: unquote(source.text()), line: statement.range().start.line + 1 }] : [];
  });
}

function rubyImports(root) {
  return nodes(root, 'call').flatMap((call) => {
    const callee = call.children().find((node) => node.kind() === 'identifier')?.text();
    if (!['require', 'require_relative', 'load'].includes(callee)) return [];
    const source = firstNode(call, ['string']);
    return source ? [{ spec: unquote(source.text()), line: call.range().start.line + 1 }] : [];
  });
}

function rustImports(root) {
  const expand = (node, prefix = '') => {
    if (node.kind() === 'use_list') return node.children().flatMap((child) => ['identifier', 'scoped_identifier', 'scoped_use_list'].includes(child.kind()) ? expand(child, prefix) : []);
    if (node.kind() === 'scoped_use_list') {
      const list = node.children().find((child) => child.kind() === 'use_list');
      const base = node.children().filter((child) => !['::', 'use_list'].includes(child.kind())).map((child) => child.text()).join('');
      return list ? expand(list, prefix ? `${prefix}::${base}` : base) : [];
    }
    const value = node.text(); return [prefix ? `${prefix}::${value}` : value];
  };
  return nodes(root, 'use_declaration').flatMap((statement) => {
    const grouped = nodes(statement, 'scoped_use_list')[0];
    if (grouped) return expand(grouped).map((spec) => ({ spec, line: statement.range().start.line + 1 }));
    const source = firstNode(statement, ['scoped_identifier', 'identifier']);
    return source ? [{ spec: source.text(), line: statement.range().start.line + 1 }] : [];
  });
}

/** Parse imports from syntax nodes, never from comments, strings, or documentation. */
export function sourceImportEntries(filePath, content) {
  const parsed = parseSource(filePath, content);
  if (!parsed) return { entries: [], errors: [] };
  const { root, errors } = parsed;
  let entries = [];
  if (/\.(?:[cm]?[jt]sx?|mts|cts)$/.test(filePath)) entries = javascriptImports(root);
  else if (/\.go$/.test(filePath)) entries = goImports(root);
  else if (/\.py$/.test(filePath)) entries = pythonImports(root);
  else if (/\.java$/.test(filePath)) entries = declarationImports(root, 'import_declaration', ['scoped_identifier', 'identifier']);
  else if (/\.kts?$/.test(filePath)) entries = declarationImports(root, 'import_header', ['identifier']);
  else if (/\.rs$/.test(filePath)) entries = rustImports(root);
  else if (/\.rb$/.test(filePath)) entries = rubyImports(root);
  else if (/\.cs$/.test(filePath)) entries = declarationImports(root, 'using_directive', ['qualified_name', 'identifier']);
  return { entries: [...new Map(entries.filter(({ spec }) => spec).map((entry) => [`${entry.line}:${entry.spec}`, entry])).values()], errors };
}

export function javascriptImportedBindings(content, filePath = 'source.ts') {
  return analyzeJavaScriptSource(content, filePath).bindingsResult;
}

function javascriptBindings(parsed) {
  const bindings = new Map();
  if (!parsed) return { bindings, errors: [] };
  for (const statement of nodes(parsed.root, 'import_statement')) {
    const source = firstNode(statement, ['string']); if (!source) continue;
    const spec = unquote(source.text()); const text = statement.text();
    const named = text.match(/import\s*\{([^}]+)\}/);
    if (named) for (const part of named[1].split(',')) {
      const [original, local = original] = part.trim().split(/\s+as\s+/); if (original && local) bindings.set(local.trim(), spec);
    }
    const namespace = text.match(/import\s+\*\s+as\s+(\w+)/); if (namespace) bindings.set(namespace[1], spec);
    const defaultBinding = text.match(/^import\s+(\w+)\s*(?:,|from)/); if (defaultBinding) bindings.set(defaultBinding[1], spec);
  }
  return { bindings, errors: parsed.errors };
}

/** Return only route handlers represented by real call-expression syntax nodes. */
export function javascriptRouteHandlers(content, filePath = 'source.ts') {
  return analyzeJavaScriptSource(content, filePath).handlersResult;
}

function routeMethod(call) {
  const callee = call.field('function');
  if (callee?.kind() !== 'member_expression') return null;
  const method = callee.field('property')?.text();
  if (!/^(?:get|post|put|patch|delete|use)$/i.test(method || '')) return null;
  const receiver = callee.field('object');
  if (/^(?:app|router|server)$/.test(receiver?.text() || '')) return method;
  if (receiver?.kind() !== 'call_expression') return null;
  const routeMember = receiver.field('function');
  return routeMember?.kind() === 'member_expression'
    && /^(?:app|router|server)$/.test(routeMember.field('object')?.text() || '')
    && routeMember.field('property')?.text() === 'route' ? method : null;
}

function javascriptHandlers(parsed) {
  if (!parsed) return { handlers: [], errors: [] };
  const handlers = [];
  for (const call of nodes(parsed.root, 'call_expression')) {
    if (!routeMethod(call)) continue;
    const args = call.field('arguments')?.children().filter((node) => !['(', ')', ','].includes(node.kind())) || [];
    const handler = args.at(-1)?.text();
    if (handler && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(handler)) handlers.push({ binding: handler.split('.')[0], line: call.range().start.line + 1 });
  }
  return { handlers, errors: parsed.errors };
}

export function analyzeJavaScriptSource(content, filePath = 'source.ts') {
  const parsed = parseSource(filePath, content);
  const importsResult = parsed ? { entries: javascriptImports(parsed.root), errors: parsed.errors } : { entries: [], errors: [] };
  return { importsResult, bindingsResult: javascriptBindings(parsed), handlersResult: javascriptHandlers(parsed) };
}

export const syntaxAnalysisInternals = { extensionLanguage };
export const SUPPORTED_AST_LANGUAGES = Object.freeze([
  { id: 'javascript-typescript', extensions: ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'] },
  { id: 'go', extensions: ['go'] }, { id: 'python', extensions: ['py'] },
  { id: 'java', extensions: ['java'] }, { id: 'kotlin', extensions: ['kt', 'kts'] },
  { id: 'rust', extensions: ['rs'] }, { id: 'ruby', extensions: ['rb'] }, { id: 'csharp', extensions: ['cs'] },
]);

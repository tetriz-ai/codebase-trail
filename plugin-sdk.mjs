// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
export const EXTRACTOR_PLUGIN_API_VERSION = '1.0';

/** @typedef {{ id: string, version: string, api_version: string, supports: (file: Record<string, unknown>) => boolean, extract: (file: Readonly<Record<string, unknown>>, repository: Readonly<Record<string, unknown>>) => ExtractorResult | null | undefined, cache_scope?: 'blob', cache_key?: string, capabilities?: { languages?: readonly string[], file_extensions?: readonly string[], claim_kinds?: readonly string[] } }} ExtractorPlugin */
/** @typedef {{ discoveries?: unknown[], claims?: unknown[], service_candidates?: unknown[], diagnostics?: unknown[] }} ExtractorResult */
/** @param {unknown} value */
const validText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** @param {ExtractorPlugin} plugin */
export function defineExtractorPlugin(plugin) {
  if (!plugin || plugin.api_version !== EXTRACTOR_PLUGIN_API_VERSION) throw new TypeError(`Extractor plugin api_version must be ${EXTRACTOR_PLUGIN_API_VERSION}.`);
  if (!validText(plugin.id) || !validText(plugin.version)) throw new TypeError('Extractor plugins require bounded id and version strings.');
  if (typeof plugin.supports !== 'function' || typeof plugin.extract !== 'function') throw new TypeError('Extractor plugins require supports and extract functions.');
  if (plugin.cache_scope !== undefined && plugin.cache_scope !== 'blob') throw new TypeError('Extractor plugin cache_scope must be blob when provided.');
  if (plugin.cache_key !== undefined && (typeof plugin.cache_key !== 'string' || plugin.cache_key.length > 2_000)) throw new TypeError('Extractor plugin cache_key must be a bounded string when provided.');
  const capabilities = { languages: [], file_extensions: [], claim_kinds: [], ...plugin.capabilities };
  for (const field of /** @type {const} */ (['languages', 'file_extensions', 'claim_kinds'])) if (!Array.isArray(capabilities[field]) || capabilities[field].some((value) => !validText(value))) throw new TypeError(`Extractor capability ${field} must be an array of bounded strings.`);
  for (const field of /** @type {const} */ (['languages', 'file_extensions', 'claim_kinds'])) capabilities[field] = Object.freeze([...capabilities[field]]);
  return Object.freeze({ ...plugin, capabilities: Object.freeze(capabilities) });
}

/** @param {ReadonlyArray<ExtractorPlugin>} plugins */
export function extractorPluginManifest(plugins) {
  return Object.freeze(plugins.map(({ id, version, api_version, capabilities }) => Object.freeze({ id, version, api_version, capabilities })));
}

/** @param {ExtractorPlugin} plugin
 * @param {Record<string, unknown>} file
 * @param {Record<string, unknown>} repository */
export function runExtractorPlugin(plugin, file, repository) {
  const result = plugin.extract(Object.freeze({ ...file }), Object.freeze({ ...repository })) ?? {};
  if (typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw new TypeError(`Extractor plugin ${plugin.id} must return a synchronous result object.`);
  }
  if (typeof result !== 'object' || Array.isArray(result) || Object.prototype.toString.call(result) !== '[object Object]') throw new TypeError(`Extractor plugin ${plugin.id} must return a synchronous result object.`);
  for (const field of /** @type {const} */ (['discoveries', 'claims', 'service_candidates', 'diagnostics'])) if (result[field] !== undefined && !Array.isArray(result[field])) throw new TypeError(`Extractor plugin ${plugin.id} returned non-array ${field}.`);
  return result;
}

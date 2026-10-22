// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
export const PROVIDER_API_VERSION = "1.0";

function requiredMethod(value, name, kind) {
  if (typeof value?.[name] !== "function") throw new TypeError(`${kind} provider must implement ${name}()`);
}

function validateIdentity(provider, kind) {
  if (!provider || typeof provider !== "object") throw new TypeError(`${kind} provider must be an object`);
  if (provider.apiVersion !== PROVIDER_API_VERSION) {
    throw new Error(`Unsupported ${kind} provider API version: ${String(provider.apiVersion)}`);
  }
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(provider.id ?? "")) throw new TypeError(`${kind} provider must have a stable id`);
  return provider;
}

/** Source providers return immutable revision identities and UTF-8 repository data. */
export function assertSourceProvider(provider) {
  validateIdentity(provider, "source");
  for (const method of ["resolveRevision", "listFiles", "readFile"]) requiredMethod(provider, method, "source");
  return provider;
}

/** Model providers expose negotiated capabilities and a cancellable JSON completion. */
export function assertModelProvider(provider) {
  validateIdentity(provider, "model");
  for (const method of ["probeCapabilities", "completeJson"]) requiredMethod(provider, method, "model");
  return provider;
}

export function sourceProviderDescriptor(provider) {
  assertSourceProvider(provider);
  return Object.freeze({ apiVersion: provider.apiVersion, id: provider.id, kind: provider.kind ?? "custom" });
}

export function modelProviderDescriptor(provider) {
  assertModelProvider(provider);
  return Object.freeze({ apiVersion: provider.apiVersion, id: provider.id, kind: provider.kind ?? "custom" });
}

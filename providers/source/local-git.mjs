// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { PROVIDER_API_VERSION } from "../contracts.mjs";

const defaultExecFile = promisify(execFileCallback);
const OBJECT_ID = /^[0-9a-f]{40,64}$/i;

function safeRepoPath(repoPath) {
  if (typeof repoPath !== "string" || !path.isAbsolute(repoPath)) throw new TypeError("Local Git checkout must be an absolute path");
  return path.resolve(repoPath);
}

function safeRelativePath(filePath) {
  if (typeof filePath !== "string" || !filePath || filePath.includes("\0") || path.isAbsolute(filePath)) throw new TypeError("Repository path must be relative");
  const normalized = filePath;
  if (normalized.split("/").some((part) => part === "..")) throw new TypeError("Repository path cannot escape the checkout");
  return normalized.replace(/^\.\//, "");
}

async function run(execFile, checkout, args, { signal, timeoutMs, maxBuffer = 32 * 1024 * 1024, encoding = "utf8" } = {}) {
  try {
    const result = await execFile("git", ["-C", checkout, ...args], { encoding, timeout: timeoutMs, maxBuffer, signal });
    return result.stdout;
  } catch (error) {
    throw new Error(`Local Git operation failed: ${String(error?.stderr || "").trim() || error.message}`, { cause: error });
  }
}

export class LocalGitSourceProvider {
  apiVersion = PROVIDER_API_VERSION;
  id = "local-git";
  kind = "local-git";

  constructor({ checkout, timeoutMs = 30_000, execFile = defaultExecFile } = {}) {
    this.checkout = safeRepoPath(checkout);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError("timeoutMs must be between 1 and 300000");
    this.timeoutMs = timeoutMs;
    this.execFile = execFile;
  }

  async resolveRevision(revision, { signal } = {}) {
    if (typeof revision !== "string" || !revision.trim() || revision.startsWith("-")) throw new TypeError("A revision is required");
    const oid = (await run(this.execFile, this.checkout, ["rev-parse", "--verify", `${revision}^{commit}`], { signal, timeoutMs: this.timeoutMs })).trim();
    if (!OBJECT_ID.test(oid)) throw new Error("Git returned an invalid object id");
    return Object.freeze({ revision: oid.toLowerCase(), requestedRevision: revision });
  }

  async listFiles({ revision, signal } = {}) {
    if (!OBJECT_ID.test(revision ?? "")) throw new TypeError("listFiles requires a resolved revision object id");
    const output = await run(this.execFile, this.checkout, ["ls-tree", "-r", "--name-only", "-z", revision], { signal, timeoutMs: this.timeoutMs, encoding: "buffer" });
    let names;
    try { names = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output); }
    catch (cause) { throw new Error("Local Git contains a filename that is not valid UTF-8", { cause }); }
    return names.split("\0").filter(Boolean);
  }

  async readFile({ revision, path: filePath, signal } = {}) {
    if (!OBJECT_ID.test(revision ?? "")) throw new TypeError("readFile requires a resolved revision object id");
    const safePath = safeRelativePath(filePath);
    return run(this.execFile, this.checkout, ["show", `${revision}:${safePath}`], { signal, timeoutMs: this.timeoutMs });
  }
}

export const localGitInternals = { safeRelativePath };

// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { PROVIDER_API_VERSION } from "../contracts.mjs";

const defaultExecFile = promisify(execFileCallback);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const OBJECT_ID = /^[0-9a-f]{40,64}$/i;

function parseJson(stdout, operation) {
  try { return JSON.parse(stdout); }
  catch (error) { throw new Error(`GitHub returned invalid JSON for ${operation}`, { cause: error }); }
}

export class GitHubGhSourceProvider {
  apiVersion = PROVIDER_API_VERSION;
  id = "github-gh";
  kind = "github";

  constructor({ repository, hostname, timeoutMs = 30_000, execFile = defaultExecFile } = {}) {
    if (!REPOSITORY.test(repository ?? "")) throw new TypeError("repository must be owner/name");
    if (hostname !== undefined && !/^[A-Za-z0-9.-]+$/.test(hostname)) throw new TypeError("Invalid GitHub hostname");
    this.repository = repository;
    this.hostname = hostname;
    this.timeoutMs = timeoutMs;
    this.execFile = execFile;
  }

  async #api(endpoint, { signal } = {}) {
    const args = ["api", endpoint];
    if (this.hostname) args.push("--hostname", this.hostname);
    try {
      const { stdout } = await this.execFile("gh", args, { encoding: "utf8", timeout: this.timeoutMs, maxBuffer: 32 * 1024 * 1024, signal });
      return parseJson(stdout, endpoint);
    } catch (error) {
      throw new Error(`GitHub source operation failed: ${error?.stderr?.trim() || error.message}`, { cause: error });
    }
  }

  async resolveRevision(revision, options = {}) {
    if (typeof revision !== "string" || !revision.trim() || revision.includes("..")) throw new TypeError("A revision is required");
    const commit = await this.#api(`repos/${this.repository}/commits/${encodeURIComponent(revision)}`, options);
    if (!OBJECT_ID.test(commit?.sha ?? "")) throw new Error("GitHub returned an invalid commit id");
    return Object.freeze({ revision: commit.sha.toLowerCase(), requestedRevision: revision });
  }

  async listFiles({ revision, signal } = {}) {
    if (!OBJECT_ID.test(revision ?? "")) throw new TypeError("listFiles requires a resolved revision object id");
    const tree = await this.#api(`repos/${this.repository}/git/trees/${revision}?recursive=1`, { signal });
    if (tree?.truncated) throw new Error("GitHub tree response was truncated; refusing incomplete repository evidence");
    return (tree?.tree ?? []).filter((entry) => entry.type === "blob" && typeof entry.path === "string").map((entry) => entry.path);
  }

  async readFile({ revision, path, signal } = {}) {
    if (!OBJECT_ID.test(revision ?? "")) throw new TypeError("readFile requires a resolved revision object id");
    if (typeof path !== "string" || !path || path.includes("\0") || path.split("/").includes("..")) throw new TypeError("Invalid repository path");
    const blob = await this.#api(`repos/${this.repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${revision}`, { signal });
    if (blob?.encoding !== "base64" || typeof blob.content !== "string") throw new Error("GitHub response was not a file blob");
    return Buffer.from(blob.content.replaceAll("\n", ""), "base64").toString("utf8");
  }
}

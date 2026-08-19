/**
 * Keeps `.git/` out of the agent's reach.
 *
 * The repo is cloned to the VFS root and `createAITools` has no chroot or
 * exclude option, so the packfile sits directly inside the model's search
 * space. `fs.grep` has no binary detection: a grep at `/` reads the pack out
 * of SQLite and scans it line by line, which is both the largest object in the
 * tree and useless to the agent. `find` similarly floods the context with
 * `.git/objects/**`.
 *
 * Guarding has two halves, and only doing the first is a common mistake:
 *   1. reject an explicit path under `.git/`, and
 *   2. filter `.git/` entries out of results, since a search rooted at `/` is
 *      a perfectly legal call that would otherwise return them anyway.
 *
 * The wrapper is an explicit re-implementation of the filesystem surface the
 * tools actually call, rather than a catch-all proxy: every guarded method is
 * named here, and a method that is not named is not reachable at all.
 *
 * This wraps only the workspace handed to the file tools. Git itself runs
 * against the DO-local workspace and is unaffected.
 */

import type { WorkspaceClient } from "@cloudflare/computer";
import type { CreateAIToolsOptions } from "@cloudflare/computer/tools";

/** The workspace surface `createAITools` reads. */
type ToolWorkspace = CreateAIToolsOptions["workspace"];
type ToolFilesystem = ToolWorkspace["fs"];

/** Matches `.git` as a path segment. `.gitignore` is deliberately not matched. */
const GIT_DIR = /(^|\/)\.git(\/|$)/;

function rejectGitPath(path: string): void {
  if (GIT_DIR.test(path)) {
    throw new Error(
      `.git/ is not readable by the agent (${path}) — it holds compressed pack data, not source`,
    );
  }
}

function outsideGitDir<T>(entries: T[], pathOf: (entry: T) => string): T[] {
  return entries.filter((entry) => !GIT_DIR.test(pathOf(entry)));
}

/** Wrap a workspace client so its filesystem cannot see `.git/`. */
export function hideGitDir(workspace: WorkspaceClient): ToolWorkspace {
  const { fs } = workspace;

  // Every method is `async` so that a rejected path surfaces as a rejected
  // promise rather than a synchronous throw, whichever way a caller invokes it.
  const guarded: ToolFilesystem = {
    stat: async (path) => {
      rejectGitPath(path);
      return fs.stat(path);
    },
    readFile: async (path, options) => {
      rejectGitPath(path);
      if (options === undefined) return fs.readFile(path);
      return fs.readFile(path, options);
    },
    writeFile: async (path, content, options) => {
      rejectGitPath(path);
      return fs.writeFile(path, content, options);
    },
    mkdir: async (path, options) => {
      rejectGitPath(path);
      return fs.mkdir(path, options);
    },
    rm: async (path, options) => {
      rejectGitPath(path);
      return fs.rm(path, options);
    },
    find: async (directory, pattern, options) => {
      rejectGitPath(directory);
      return outsideGitDir(await fs.find(directory, pattern, options), (entry) => entry.path);
    },
    grep: async (pattern, path, options) => {
      rejectGitPath(path);
      return outsideGitDir(await fs.grep(pattern, path, options), (match) => match.path);
    },
    readdir: async (path, options) => {
      rejectGitPath(path);
      return outsideGitDir(await fs.readdir(path, options), (entry) => entry.name);
    },
  };

  // `git` and `artifacts` are lazy getters that mint an RPC stub on read, so
  // they are deliberately not carried over: the tools never ask for them.
  return { fs: guarded, runtime: workspace.runtime, assets: workspace.assets };
}

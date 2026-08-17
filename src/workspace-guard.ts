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
 * This wraps only the workspace handed to the file tools. Git itself runs
 * against the DO-local workspace and is unaffected.
 */

/** Matches `.git` as a path segment. `.gitignore` is deliberately not matched. */
const GIT_DIR = /(^|\/)\.git(\/|$)/;

/** Index of the path argument per method; `grep(pattern, path, options)`. */
const PATH_ARGUMENT: Record<string, number> = { grep: 1 };

function isGitPath(value: unknown): boolean {
  return typeof value === "string" && GIT_DIR.test(value);
}

function withoutGitEntries(result: unknown): unknown {
  if (!Array.isArray(result)) return result;
  return result.filter((entry) => {
    if (typeof entry === "string") return !isGitPath(entry);
    if (entry && typeof entry === "object") {
      const { path, name, parentPath } = entry as {
        path?: string;
        name?: string;
        parentPath?: string;
      };
      const resolved = path ?? (parentPath ? `${parentPath}/${name}` : name);
      return !isGitPath(resolved);
    }
    return true;
  });
}

/** Wrap a workspace client so its filesystem cannot see `.git/`. */
export function hideGitDir<T extends { fs: unknown }>(workspace: T): T {
  const fs = new Proxy(workspace.fs as Record<string, unknown>, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      const index = PATH_ARGUMENT[property] ?? 0;
      return async (...args: unknown[]) => {
        if (isGitPath(args[index])) {
          throw new Error(
            `.git/ is not readable by the agent (${String(args[index])}) — it holds compressed pack data, not source`,
          );
        }
        return withoutGitEntries(await (value as (...a: unknown[]) => unknown).apply(target, args));
      };
    },
  });

  return new Proxy(workspace, {
    get: (target, property, receiver) =>
      property === "fs" ? fs : Reflect.get(target, property, receiver),
  });
}

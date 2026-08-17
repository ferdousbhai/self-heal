/**
 * FixAgent — a Durable Object hosting a `@cloudflare/computer` Workspace: a
 * SQLite-backed filesystem holding the checked-out repo, plus an
 * isomorphic-git client that operates directly on it. Git needs no execution
 * backend, which is why no container is involved.
 *
 * Git lives here rather than in the workflow because `getWorkspace(stub).git`
 * is a `WorkspaceGitStub` exposing only `cli(argv)` across RPC — the typed
 * `GitClient` exists solely on the DO-local `Workspace`, which
 * `getWorkspace(this)` resolves. A second payoff: the GitHub token is passed
 * to these methods and used DO-side only, so it never enters the workspace
 * filesystem the model's file tools can read.
 *
 * One DO instance per run (`fix-<runId>`), disposed when the run ends.
 */

import { DurableObject } from "cloudflare:workers";
import {
  type DurableObjectStorageLike,
  type WorkspaceHandle,
  type WorkspaceOptions,
  getWorkspace,
  withWorkspace,
} from "@cloudflare/computer";
import { type GitClient, createGitClient } from "@cloudflare/computer/git";
import type { Env } from "./env";

const GIT_IDENTITY = {
  name: "self-heal[bot]",
  email: "self-heal@users.noreply.github.com",
} as const;

export type GitCredentials = {
  url: string;
  ref: string;
  headers?: Record<string, string>;
};

class FixAgentBase extends DurableObject<Env> {}

// Needs an explicit return type: an inferred one would reference FixAgent
// through its own base expression, and `ctx` is protected on DurableObject.
function workspaceOptions(self: InstanceType<typeof FixAgentBase>): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    // Opt in to the git client; without this `ws.git` is undefined. The
    // subpath pulls in isomorphic-git, keeping it out of the default graph.
    git: createGitClient(),
    defaultGitIdentity: { ...GIT_IDENTITY },
  };
}

export class FixAgent extends withWorkspace(FixAgentBase, workspaceOptions) {
  /** The DO-local `Workspace`, whose `git` is the typed client (RPC callers
   *  get the cli-only stub instead). Typed `any` by the library. */
  async #git(): Promise<GitClient> {
    return (await getWorkspace(this as unknown as WorkspaceHandle)).git as GitClient;
  }

  /**
   * Shallow-clone the repo into the workspace. `depth: 1` keeps the packfile
   * small — the client re-reads it from DO SQLite on every git call, so
   * history is expensive here in a way it is not on a real disk.
   *
   * Idempotent: a workflow retry re-enters this against the same DO, so any
   * partial tree from a failed attempt is cleared first. Without that, the
   * retry hits `AlreadyInitializedError` and the configured retries are worse
   * than useless.
   */
  async cloneRepo(credentials: GitCredentials): Promise<void> {
    const ws = await getWorkspace(this as unknown as WorkspaceHandle);
    for (const entry of await ws.fs.readdir("/")) {
      await ws.fs.rm(`/${entry.name}`, { recursive: true, force: true });
    }
    await (ws.git as GitClient).clone({
      url: credentials.url,
      ref: credentials.ref,
      depth: 1,
      headers: credentials.headers,
    });
  }

  /** Paths the agent touched, as `git status` sees them. */
  async changedPaths(): Promise<string[]> {
    const git = await this.#git();
    const entries = await git.status();
    return entries.map((entry) => entry.path);
  }

  /**
   * Stage everything, commit, and push to a fresh remote branch. The local
   * ref stays the cloned base branch; only `remoteRef` differs, so the base
   * branch is never written to. Throws if the remote rejects.
   */
  async commitAndPush(
    message: string,
    credentials: GitCredentials,
    remoteBranch: string,
  ): Promise<void> {
    const git = await this.#git();
    await git.add({ paths: [], all: true });
    await git.commit({ message });
    const result = await git.push({
      url: credentials.url,
      ref: credentials.ref,
      remoteRef: remoteBranch,
      headers: credentials.headers,
    });
    if (!result.ok) throw new Error(result.error ?? "push rejected by remote");
  }

  /**
   * Drop the checkout. Without this every run leaves a full repo tree in DO
   * SQLite forever — the container this replaced was ephemeral, so disposal
   * is a cost the move into a Durable Object introduces.
   */
  async dispose(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { type WorkspaceHandle, getWorkspace } from "@cloudflare/computer";
import { createAITools } from "@cloudflare/computer/tools";
import { generateText, hasToolCall, tool } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import type { GitCredentials } from "./agent";
import type { Env } from "./env";
import { apiHeaders, installationToken } from "./github";
import { hideGitDir } from "./workspace-guard";
import {
  type FixPromptInput,
  FIX_SYSTEM_PROMPT,
  buildFixPrompt,
  parseVerdict,
} from "./prompt";

const VERDICT_REPORT = z.object({
  verdict: z
    .enum(["fix", "noop"])
    .describe("`fix` if you made edits that resolve the error; `noop` if it is not fixable here."),
  summary: z
    .string()
    .describe("One line: what you changed, or why this cannot be fixed by a code change."),
});

/**
 * The verdict is a tool call, not prose. A model that simply stops talking —
 * as happened when the loop hit its step ceiling with an empty final message —
 * produces no verdict at all rather than an ambiguous one, and calling this is
 * the only way for the model to end its turn cleanly.
 */
const REPORT_VERDICT = tool({
  description:
    "Report your final verdict and end your turn. Call this exactly once, when you are finished.",
  inputSchema: VERDICT_REPORT,
  execute: async () => ({ recorded: true }),
});

/** GitHub's pull-request response, read back for the URL (or the error). */
const PULL_REQUEST_RESPONSE = z
  .object({ html_url: z.string().optional(), message: z.string().optional() })
  .catch({});

export type FixWorkflowParams = FixPromptInput & { runId: string };

/**
 * Paths the agent is told not to touch and is not trusted to leave alone.
 * The repo is cloned to the VFS root and `createAITools` has no chroot
 * option, so `.git/`, CI config, and lockfiles all sit inside the model's
 * write namespace. This is the enforcement point for the prompt's rule.
 */
const PROTECTED = [/^\.git\//, /^\.github\//, /(^|\/)[^/]*\.lock$/, /(^|\/)\.env/];

export class FixWorkflow extends WorkflowEntrypoint<Env, FixWorkflowParams> {
  async run(event: WorkflowEvent<FixWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    const { runId, repo, branch } = p;

    try {
      // A GitHub App installation token, minted per run and valid for an hour.
      // Nothing long-lived that can write to the repo exists anywhere.
      //
      // Deliberately NOT wrapped in step.do: Workflows persist every step's
      // return value, so a token returned from a step is written verbatim into
      // the instance record and printed by `wrangler workflows instances
      // describe`. Minting here costs one API call per replay and keeps the
      // credential out of durable storage entirely.
      if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_KEY) {
        throw new Error("no github app configured — run /app/setup, then `pnpm app:promote`");
      }
      const token = await installationToken(
        { appId: this.env.GITHUB_APP_ID, privateKey: this.env.GITHUB_APP_KEY },
        repo,
      );

      const git: GitCredentials = {
        url: `https://github.com/${repo}.git`,
        ref: branch,
        // isomorphic-git's `clone` takes `headers` (it has no `onAuth`), so
        // both clone and push authenticate the same way rather than embedding
        // the token in the remote URL — keeping it out of `.git/config`, where
        // the model's file tools could otherwise read it back.
        headers: { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` },
      };

      await step.do("mark running", { retries: { limit: 3, delay: "1 second" } }, async () => {
        await this.env.DB.prepare("UPDATE fix_runs SET status = 'running' WHERE id = ?")
          .bind(runId)
          .run();
      });

      // 1. Clone. Lets failures throw so the configured retries actually fire
      //    — this is the most transient-failure-prone step in the pipeline.
      await step.do(
        "clone",
        { retries: { limit: 2, delay: "5 seconds" }, timeout: "10 minutes" },
        () => this.agent(runId).cloneRepo(git),
      );

      // 2. Run the agent loop. retries:0 with the error caught in-step, so a
      //    timeout or a model error never silently re-spends the budget; the
      //    run is recorded and re-triggerable instead.
      const agent = await step.do(
        "agent",
        { retries: { limit: 0, delay: "1 second" }, timeout: "30 minutes" },
        async () => {
          const ws = await getWorkspace(this.handle(runId));
          const workersai = createWorkersAI({ binding: this.env.AI });
          try {
            const result = await generateText({
              model: workersai(this.env.MODEL),
              system: FIX_SYSTEM_PROMPT,
              prompt: buildFixPrompt(p),
              tools: {
                ...createAITools({
                  workspace: hideGitDir(ws),
                  read: { maxBytes: 64 * 1024, maxLines: 1200 },
                }),
                report_verdict: REPORT_VERDICT,
              },
              // Ending the loop is an explicit action the model takes, not
              // something inferred from prose it may never write. No step
              // ceiling: the loop runs until the model reports its verdict.
              stopWhen: hasToolCall("report_verdict"),
            });
            const verdictCall = result.steps
              .flatMap((s) => s.toolCalls)
              .find((call) => call.toolName === "report_verdict");
            const reported = verdictCall
              ? VERDICT_REPORT.safeParse(verdictCall.input).data
              : undefined;
            return {
              ok: true as const,
              verdict: reported?.verdict ?? parseVerdict(result.text),
              summary: reported?.summary ?? result.text.trim().split("\n", 1)[0] ?? "",
              steps: result.steps.length,
            };
          } catch (error) {
            return { ok: false as const, error: String(error) };
          }
        },
      );
      if (!agent.ok) return await this.done(runId, "failed", `agent failed: ${clip(agent.error)}`);

      // 3. Short-circuit before touching git: `status` walks the whole tree on
      //    the DO's CPU, and the prompt steers hard toward NOOP, so the
      //    discarded-result path would otherwise be the common one.
      if (agent.verdict !== "fix") {
        return await this.done(
          runId,
          "noop",
          agent.verdict === "noop"
            ? `agent reported noop: ${agent.summary.slice(0, 300)}`
            : `agent ended without a verdict after ${agent.steps} steps`,
        );
      }

      const changed = await step.do(
        "inspect diff",
        { retries: { limit: 2, delay: "2 seconds" }, timeout: "5 minutes" },
        () => this.agent(runId).changedPaths(),
      );
      if (changed.length === 0) {
        return await this.done(runId, "noop", "agent reported a fix but changed no files");
      }

      const blocked = changed.filter((path) => PROTECTED.some((rule) => rule.test(path)));
      if (blocked.length > 0) {
        return await this.done(runId, "blocked", `touched protected paths: ${blocked.join(", ")}`);
      }

      // 4. Commit to a branch and open a PR. Only reached on an explicit FIX,
      //    a real diff, and a clean path check. Nothing is ever written to the
      //    base branch: the agent cannot verify its own fix (no shell, no test
      //    runner), so the PR's CI checks are where verification happens and a
      //    human decides whether it merges.
      const summary = sanitizeSummary(
        `fix(autofix): ${p.errorName}${p.operation ? ` (${p.operation})` : ""}`,
      );
      const head = `self-heal/${runId.slice(0, 8)}-${slug(p.errorName)}`;
      await step.do(
        "commit and push branch",
        { retries: { limit: 1, delay: "5 seconds" }, timeout: "10 minutes" },
        () => this.agent(runId).commitAndPush(summary, git, head),
      );

      const pr = await step.do(
        "open pull request",
        { retries: { limit: 2, delay: "10 seconds" }, timeout: "5 minutes" },
        () => this.openPullRequest(token, repo, head, branch, summary, p, agent.summary, changed),
      );
      return await this.done(runId, "proposed", `${summary} — ${pr}`);
    } catch (error) {
      return await this.done(runId, "failed", clip(String(error)));
    } finally {
      // Always drop the checkout; otherwise every run leaves a repo tree in
      // DO SQLite indefinitely. Best-effort: a throw here would replace the
      // run's outcome, which is already recorded in D1 by this point.
      try {
        await step.do("cleanup", { retries: { limit: 2, delay: "5 seconds" } }, () =>
          this.agent(runId).dispose(),
        );
      } catch (error) {
        console.warn("[self-heal] cleanup failed", { runId, error: String(error) });
      }
    }
  }

  private agent(runId: string) {
    return this.env.FIX_AGENT.get(this.env.FIX_AGENT.idFromName(`fix-${runId}`));
  }

  /** The DO stub as a workspace handle. */
  private handle(runId: string): WorkspaceHandle {
    // SAFETY: `withWorkspace` gives FixAgent the `__getWorkspaceStub` method
    // this needs, but RPC projects its return to `Stub<WorkspaceStub>` and
    // `WorkspaceStub` carries a `#private` brand — so no `DurableObjectStub`
    // can satisfy `WorkspaceStubHost` structurally. Library-side nominal
    // typing, named once here.
    return this.agent(runId) as WorkspaceHandle;
  }

  /**
   * Open the PR via the GitHub REST API and return its URL.
   *
   * Uses the same installation token as the push; the App is granted
   * `contents: write` + `pull_requests: write` and nothing else.
   */
  private async openPullRequest(
    token: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    error: FixPromptInput,
    verdict: string,
    changed: string[],
  ): Promise<string> {
    const body = [
      "Opened automatically by [self-heal](https://github.com/ferdousbhai/self-heal) in response to a caught production error.",
      "",
      "### Error",
      "",
      `- **Name:** \`${error.errorName}\``,
      ...(error.component ? [`- **Component:** \`${error.component}\``] : []),
      ...(error.operation ? [`- **Operation:** \`${error.operation}\``] : []),
      ...(error.message ? [`- **Message:** ${error.message}`] : []),
      ...(error.stack ? ["", "<details><summary>Stack trace</summary>", "", "```", error.stack, "```", "", "</details>"] : []),
      "",
      "### Agent's account of the fix",
      "",
      "> " + verdict.trim().split("\n").join("\n> "),
      "",
      "### Files changed",
      "",
      ...changed.map((path) => `- \`${path}\``),
      "",
      "---",
      "",
      "⚠️ **This fix was never executed.** The agent has no shell, test runner, or typechecker —",
      "it reasoned from reading the code alone. Rely on this PR's checks and your own review.",
    ].join("\n");

    const response = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: { ...apiHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ title, head, base, body, maintainer_can_modify: true }),
    });

    const payload = PULL_REQUEST_RESPONSE.parse(await response.json());
    if (!response.ok || !payload.html_url) {
      throw new Error(`github ${response.status}: ${payload.message ?? "no pull request url"}`);
    }
    return payload.html_url;
  }

  private async done(runId: string, outcome: string, summary: string) {
    await this.env.DB.prepare(
      "UPDATE fix_runs SET status = 'done', outcome = ?, summary = ?, completed_at = ? WHERE id = ?",
    )
      .bind(outcome, summary, Date.now(), runId)
      .run();
    return { verdict: outcome, summary };
  }
}

function clip(value: string, max = 2000): string {
  return value.length > max ? value.slice(-max) : value;
}

function sanitizeSummary(value: string): string {
  return value.replace(/[^\w\s()\-:./@]/g, "").slice(0, 100) || "fix(autofix)";
}

/** Branch-name-safe fragment of the error name. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "error";
}

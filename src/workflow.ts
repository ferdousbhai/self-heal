import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { type WorkspaceHandle, getWorkspace } from "@cloudflare/computer";
import { createAITools } from "@cloudflare/computer/tools";
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { GitCredentials } from "./agent";
import { type Env, intVar } from "./env";
import { type FixPromptInput, FIX_SYSTEM_PROMPT, buildFixPrompt, parseVerdict } from "./prompt";

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
    const token = this.env.GITHUB_TOKEN;
    const git: GitCredentials = {
      url: `https://github.com/${repo}.git`,
      ref: branch,
      // isomorphic-git's `clone` takes `headers` (it has no `onAuth`), so both
      // clone and push authenticate the same way rather than embedding the
      // token in the remote URL — keeping it out of `.git/config`, where the
      // model's file tools could otherwise read it back.
      headers: token ? { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` } : undefined,
    };

    try {
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
              tools: createAITools({ workspace: ws, read: { maxBytes: 64 * 1024, maxLines: 1200 } }),
              stopWhen: stepCountIs(intVar(this.env.MAX_AGENT_STEPS, 24)),
            });
            return { ok: true as const, text: result.text, steps: result.steps.length };
          } catch (error) {
            return { ok: false as const, error: String(error) };
          }
        },
      );
      if (!agent.ok) return await this.done(runId, "failed", `agent failed: ${clip(agent.error)}`);

      // 3. Short-circuit before touching git: `status` walks the whole tree on
      //    the DO's CPU, and the prompt steers hard toward NOOP, so the
      //    discarded-result path would otherwise be the common one.
      const verdict = parseVerdict(agent.text);
      if (verdict !== "fix") {
        return await this.done(
          runId,
          "noop",
          verdict === "noop"
            ? `agent reported noop: ${agent.text.trim().split("\n", 1)[0]?.slice(0, 200)}`
            : `agent produced no FIX/NOOP verdict (${agent.steps} steps)`,
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

      // 4. Commit + push. Only reached on an explicit FIX, a real diff, and
      //    a clean path check.
      const summary = sanitizeSummary(
        `fix(autofix): ${p.errorName}${p.operation ? ` (${p.operation})` : ""}`,
      );
      await step.do(
        "commit and push",
        { retries: { limit: 1, delay: "5 seconds" }, timeout: "10 minutes" },
        () => this.agent(runId).commitAndPush(summary, git),
      );
      return await this.done(runId, "fixed", summary);
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

  /**
   * The DO stub as a workspace handle. `WorkspaceStubHost` can never be
   * satisfied structurally by a `DurableObjectStub` — RPC projects the return
   * of `__getWorkspaceStub` to `Stub<WorkspaceStub>`, and `WorkspaceStub`
   * carries a `#private` brand. Library-side nominal typing, named once here.
   */
  private handle(runId: string): WorkspaceHandle {
    return this.agent(runId) as unknown as WorkspaceHandle;
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

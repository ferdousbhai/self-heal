import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { getWorkspace } from "@cloudflare/computer";
import type { Env } from "./env";
import { buildFixPrompt, parseVerdict } from "./prompt";

export type FixWorkflowParams = {
  runId: string;
  repo: string; // owner/repo
  branch: string;
  errorName: string;
  component?: string;
  operation?: string;
  message?: string;
  stack?: string;
};

// Native container filesystem (fast, ephemeral), not the FUSE-backed VFS.
const WORKDIR = "/tmp/repo";
const PI_TIMEOUT_MS = 25 * 60 * 1000;
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 14 * 60 * 1000;
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-+=:,./@%]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

function doName(runId: string): string {
  return `fix-${runId}`;
}

async function workspaceFor(env: Env, runId: string) {
  const stub = env.FIX_AGENT.get(env.FIX_AGENT.idFromName(doName(runId)));
  return getWorkspace(stub as unknown as Parameters<typeof getWorkspace>[0]);
}

type ExecOutcome = { exitCode: number; stdout: string; stderr: string };

async function execInAgent(
  env: Env,
  runId: string,
  command: string,
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<ExecOutcome> {
  const ws = await workspaceFor(env, runId);
  const handle = await ws.runtime.exec(command, {
    backend: "container",
    encoding: "utf8",
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  const result = await handle.result();
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export class FixWorkflow extends WorkflowEntrypoint<Env, FixWorkflowParams> {
  async run(event: WorkflowEvent<FixWorkflowParams>, step: WorkflowStep) {
    const p = event.payload;
    const { runId, repo, branch } = p;
    const publicUrl = `https://github.com/${repo}.git`;
    // The GitHub token is interpolated only into the clone/push URL for those
    // two commands; it never enters the agent's environment or git config.
    const authedUrl = this.env.GITHUB_TOKEN
      ? `https://x-access-token:${this.env.GITHUB_TOKEN}@github.com/${repo}.git`
      : publicUrl;

    await step.do("mark running", { retries: { limit: 3, delay: "1 second" } }, async () => {
      await this.env.DB.prepare("UPDATE fix_runs SET status = 'running' WHERE id = ?")
        .bind(runId)
        .run();
    });

    // 1. Clone. The token is in the command env only; the remote URL is
    //    rewritten back to the public URL so the agent never reads it.
    const clone = await step.do("clone", { retries: { limit: 2, delay: "5 seconds" }, timeout: "10 minutes" }, () =>
      execInAgent(
        this.env,
        runId,
        [
          `rm -rf ${shellQuote(WORKDIR)}`,
          `git clone --depth 1 --branch ${shellQuote(branch)} ${shellQuote(authedUrl)} ${shellQuote(WORKDIR)}`,
          `git -C ${shellQuote(WORKDIR)} remote set-url origin ${shellQuote(publicUrl)}`,
          `git -C ${shellQuote(WORKDIR)} config user.email "self-heal@users.noreply.github.com"`,
          `git -C ${shellQuote(WORKDIR)} config user.name "self-heal[bot]"`,
        ].join(" && "),
        { timeoutMs: CLONE_TIMEOUT_MS },
      ),
    );
    if (clone.exitCode !== 0) {
      await this.finish(runId, "failed", `clone failed: ${clip(clone.stderr)}`);
      return { verdict: "failed" };
    }

    // 2. Install dependencies (configurable; may be empty).
    const installCommand = (this.env.INSTALL_COMMAND || "").trim();
    if (installCommand) {
      const install = await step.do("install deps", { retries: { limit: 0, delay: "1 second" }, timeout: "15 minutes" }, () =>
        execInAgent(this.env, runId, installCommand, { cwd: WORKDIR, timeoutMs: INSTALL_TIMEOUT_MS }),
      );
      if (install.exitCode !== 0) {
        // Non-fatal: the agent can still inspect and fix without deps.
        console.warn("[self-heal] dependency install failed (continuing)", {
          runId,
          error: clip(install.stderr),
        });
      }
    }

    // 3. Run pi headlessly. retries:0 so a timeout/ambiguity never re-runs the
    //    model spend; a failed run is simply recorded and re-triggerable.
    const prompt = buildFixPrompt(p);
    const pi = await step.do("run agent", { retries: { limit: 0, delay: "1 second" }, timeout: "30 minutes" }, async () => {
      const ws = await workspaceFor(this.env, runId);
      await ws.fs.writeFile("/workspace/prompt.md", prompt);
      const cmd = [
        "pi",
        "-p",
        "--no-session",
        "--provider",
        "cloudflare-workers-ai",
        "--model",
        shellQuote(this.env.MODEL),
        shellQuote("@/workspace/prompt.md"),
      ].join(" ");
      return execInAgent(this.env, runId, cmd, {
        cwd: WORKDIR,
        env: {
          CLOUDFLARE_API_KEY: this.env.CLOUDFLARE_API_KEY,
          CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          PI_CODING_AGENT_DIR: "/tmp/pi-agent",
        },
        timeoutMs: PI_TIMEOUT_MS,
      });
    });

    const verdict = parseVerdict(`${pi.stdout}\n${pi.stderr}`);
    const dirty = await step.do("inspect diff", { retries: { limit: 2, delay: "2 seconds" }, timeout: "2 minutes" }, async () => {
      const r = await execInAgent(this.env, runId, `git -C ${shellQuote(WORKDIR)} status --porcelain`, { cwd: WORKDIR });
      return r.exitCode === 0 && r.stdout.trim().length > 0;
    });

    if (pi.exitCode !== 0) {
      await this.finish(runId, "failed", `agent failed: ${clip(pi.stderr || pi.stdout)}`);
      return { verdict: "failed" };
    }
    if (verdict !== "fix" || !dirty) {
      await this.finish(runId, "noop", verdict === "noop" ? "agent reported noop" : "no change produced");
      return { verdict: "noop" };
    }

    // 4. Commit + push (only on an explicit FIX verdict + a non-empty diff).
    const summary = sanitizeSummary(`fix(autofix): ${p.errorName}${p.operation ? ` (${p.operation})` : ""}`);
    const push = await step.do("commit and push", { retries: { limit: 1, delay: "5 seconds" }, timeout: "5 minutes" }, () =>
      execInAgent(
        this.env,
        runId,
        [
          `git -C ${shellQuote(WORKDIR)} add -A`,
          `git -C ${shellQuote(WORKDIR)} commit -m ${shellQuote(summary)}`,
          `git -C ${shellQuote(WORKDIR)} push ${shellQuote(authedUrl)} HEAD:${shellQuote(branch)}`,
        ].join(" && "),
        { cwd: WORKDIR, timeoutMs: PUSH_TIMEOUT_MS },
      ),
    );

    if (push.exitCode === 0) {
      await this.finish(runId, "fixed", summary);
      return { verdict: "fixed", summary };
    }
    await this.finish(runId, "failed", `push failed: ${clip(push.stderr)}`);
    return { verdict: "failed" };
  }

  private async finish(runId: string, outcome: string, summary: string | null): Promise<void> {
    await this.env.DB.prepare(
      "UPDATE fix_runs SET status = 'done', outcome = ?, summary = ?, completed_at = ? WHERE id = ?",
    )
      .bind(outcome, summary, Date.now(), runId)
      .run();
  }
}

function clip(value: string, max = 2000): string {
  return value.length > max ? value.slice(-max) : value;
}

function sanitizeSummary(value: string): string {
  return value.replace(/[^\w\s()\-:./@]/g, "").slice(0, 100) || "fix(autofix)";
}

/**
 * Self-heal Worker environment. Bindings are declared in wrangler.jsonc;
 * run `pnpm types` to regenerate worker-configuration.d.ts, or keep this
 * interface as the source of truth for typechecking.
 */
export interface Env {
  // vars
  REPO: string;
  DEFAULT_BRANCH: string;
  MODEL: string;
  MAX_AGENT_STEPS: string;
  COOLDOWN_HOURS: string;
  MAX_RUNS_PER_HOUR: string;
  // secrets (Cloudflare Worker secrets, set with `wrangler secret put ...`)
  //
  // No GitHub credential here: self-heal authenticates as a GitHub App, whose
  // private key reaches D1 through the manifest flow and mints a fresh
  // one-hour installation token per run. See src/github.ts.
  TRIGGER_SECRET: string;
  // bindings
  AI: Ai;
  DB: D1Database;
  // Parameterized so the workflow can call FixAgent's typed git methods
  // (cloneRepo / changedPaths / commitAndPush) over RPC.
  FIX_AGENT: DurableObjectNamespace<import("./agent").FixAgent>;
  FIX_WORKFLOW: Workflow;
}

/** Parse a numeric `var`, falling back when unset or degenerate. */
export function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

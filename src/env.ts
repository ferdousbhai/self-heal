/**
 * Self-heal Worker environment. Bindings are declared in wrangler.jsonc;
 * run `pnpm types` to regenerate worker-configuration.d.ts, or keep this
 * interface as the source of truth for typechecking.
 */
export interface Env {
  // vars
  REPO: string;
  DEFAULT_BRANCH: string;
  INSTALL_COMMAND: string;
  MODEL: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  COOLDOWN_HOURS: string;
  MAX_RUNS_PER_HOUR: string;
  // secrets (Cloudflare Worker secrets, set with `wrangler secret put ...`)
  TRIGGER_SECRET: string;
  CLOUDFLARE_API_KEY: string;
  GITHUB_TOKEN: string;
  // bindings
  DB: D1Database;
  FIX_AGENT: DurableObjectNamespace;
  FIX_WORKFLOW: Workflow;
}

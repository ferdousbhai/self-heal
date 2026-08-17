# self-heal

Self-healing agent for Cloudflare Workers. When your app catches an error, it POSTs a
small payload to this service; `self-heal` clones the repo, diagnoses the bug, fixes it,
and pushes — which redeploys via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

The whole thing runs **inside a Worker**. No container, no sandbox, no API token for the
model. If the error is not fixable by a code change (provider outage, invalid user input,
infrastructure, non-reproducible), the agent reports `NOOP` and nothing is pushed.

## How it works

```
app error ──► POST /fix (HMAC-signed)
                 │  admission control (D1): dedupe · rate limit · kill switch
                 ▼
          FixWorkflow (durable steps)
            1. clone          isomorphic-git → SQLite VFS in a Durable Object
            2. agent          AI SDK tool loop on @cf/deepseek-ai/deepseek-v4-pro-0813
            3. verdict        parse FIX / NOOP  +  git status
            4. commit+push    only on FIX *and* a non-empty diff
```

## Architecture

- **`@cloudflare/computer`** supplies a SQLite-backed filesystem in a Durable Object plus
  an [`isomorphic-git`](https://github.com/isomorphic-git/isomorphic-git) client that runs
  directly against it — the docs are explicit that git needs "no backend or shell".
  That is why there is no container: the two capabilities the fix loop needs are the two
  that work without one.
- **`@cloudflare/computer/tools`** provides the agent's file tools (`read`, `ls`, `find`,
  `grep`, `write`, `edit`, `delete`) over that same filesystem.
- **`workers-ai-provider`** runs the AI SDK loop against the `env.AI` binding. The binding
  is authenticated by the platform, so **there is no `CLOUDFLARE_API_KEY`**.
- **Workflows** orchestrate the run with durable steps and retries.
- **D1** is the audit log and admission-control store.

### The trade-off, stated plainly

There is no shell, so the agent **cannot run the project's tests, typechecker, or build**
before pushing. It fixes from reading code alone. The safety net is Workers Builds: a bad
fix fails the build and never reaches production. If you want the fix validated *before*
the push, you want a container backend (or a GitHub Actions runner) in the loop instead.

The prompt is written to lean hard on this — the agent is told it cannot verify anything
and must answer `NOOP` when it is not confident from the code it has actually read.

## Setup

```bash
pnpm install

# 1. D1 database
pnpm db:create              # prints the database_id → put it in wrangler.jsonc
pnpm db:init                # add --remote for the production database

# 2. Secrets (stored in Cloudflare as Worker env secrets, never on disk)
wrangler secret put TRIGGER_SECRET   # shared HMAC secret (random 32+ chars)
wrangler secret put GITHUB_TOKEN     # fine-grained PAT with Contents:Write on the repo

# 3. Deploy
pnpm deploy
```

Update the `vars` in `wrangler.jsonc` (`REPO`, `DEFAULT_BRANCH`, `MODEL`, `MAX_AGENT_STEPS`).

> Deploys take a minute or so to reach every colo. Triggering a run immediately after
> `wrangler deploy` can hit a colo still serving the previous version, which surfaces as
> `The RPC receiver does not implement the method "…"`. Wait, then trigger.

## Triggering

Sign the raw JSON body with `TRIGGER_SECRET` using HMAC-SHA256, hex-encoded, in the
`x-self-heal-signature` header:

```bash
curl -X POST https://self-heal.<your-worker>.workers.dev/fix \
  -H 'content-type: application/json' \
  -H "x-self-heal-signature: $(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$TRIGGER_SECRET" | awk '{print $2}')" \
  -d "$BODY"
```

```json
{
  "errorName": "TimeoutError",
  "component": "server",
  "operation": "route_agent_request",
  "message": "Chunk timeout of 30000ms exceeded",
  "stack": "…",
  "repo": "owner/repo",
  "branch": "master"
}
```

### Wiring an app to it

In your central error handler, fire-and-forget (never throw, never block):

```ts
async function reportToSelfHeal(error: unknown, tags: Record<string, string>) {
  const body = JSON.stringify({
    errorName: error instanceof Error ? error.name : "UnknownError",
    component: tags.component,
    operation: tags.operation,
    message: error instanceof Error ? error.message : undefined,
  });
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.TRIGGER_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  await fetch(`${env.SELF_HEAL_URL}/fix`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-self-heal-signature": sig },
    body,
  }).catch(() => {});
}
```

## Safety & cost controls

- **HMAC auth** on every trigger (shared `TRIGGER_SECRET`).
- **Dedup**: one run per fingerprint at a time; a `fixed` fingerprint is quiet for
  `COOLDOWN_HOURS` (default 24h).
- **Rate limit**: `MAX_RUNS_PER_HOUR` (default 5) global budget.
- **Step ceiling**: `MAX_AGENT_STEPS` (default 24) bounds tool-call rounds per run.
- **Kill switch**: set `self_heal_settings.enabled` to anything but `1` in D1.
- **No-op contract**: the agent must reply `FIX` or `NOOP`; commit+push happens only on an
  explicit `FIX` verdict **and** a non-empty `git status`.
- **Token hygiene**: the GitHub token is passed to the Durable Object's git methods and
  used there only. It is never written into `.git/config` (auth goes in an HTTP header,
  not the remote URL) and never lands in the workspace filesystem, so the model's file
  tools cannot read it.

## License

MIT

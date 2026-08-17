# self-heal

Self-healing agent for Cloudflare Workers. When your app catches an error, it POSTs a
small payload to this service; `self-heal` runs [pi](https://github.com/badlogic/pi)
headlessly inside a Cloudflare **Computer** container to `git clone` the repo, diagnose and
fix the bug, then commit and push — which redeploys via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).

If the error is not fixable by a code change (provider outage, invalid user input,
infrastructure, non-reproducible), the agent replies `NOOP` and nothing is pushed.

## How it works

```
app error ──► POST /fix (HMAC-signed)
                 │  admission control (D1): dedupe · rate limit · kill switch
                 ▼
          FixWorkflow (durable steps)
            1. clone          git clone (GitHub token in that step's env only)
            2. install        pnpm install --frozen-lockfile
            3. agent          pi -p --provider cloudflare-workers-ai --model @cf/deepseek-ai/deepseek-v4-pro-0813
            4. verdict        parse FIX / NOOP + `git status --porcelain`
            5. commit+push    only on FIX + non-empty diff
```

The agent works in the durable Workspace VFS (`/workspace/repo`), which persists
across container replacements (the container's native `/tmp` does not).

## Architecture

- **`@cloudflare/computer`** provides the container + `runtime.exec` (the
  [`examples/container`](https://github.com/cloudflare/computer/tree/main/examples/container)
  pattern: a Durable Object hosting `computerd`).
- **pi** is the coding agent, installed in the container image and driven headlessly via
  `pi -p @prompt.md`.
- **Workflows** orchestrate the long-running run with retries and durable state.
- **D1** is the audit log + admission-control store.

## Setup

```bash
pnpm install

# 1. D1 database
pnpm db:create              # prints the database_id → put it in wrangler.jsonc
pnpm db:init

# 2. Secrets (stored in Cloudflare as Worker env secrets, never on disk)
wrangler secret put TRIGGER_SECRET      # shared HMAC secret (random 32+ chars)
wrangler secret put CLOUDFLARE_API_KEY  # a Cloudflare API token with Workers AI access
wrangler secret put GITHUB_TOKEN        # fine-grained PAT with Contents:Write on the repo

# 3. Deploy (builds + pushes the container image from ./Dockerfile)
pnpm deploy
```

Update the `vars` in `wrangler.jsonc` (repo, branch, install command) for your target.

The container image is built from `./Dockerfile` (Debian + node 22 + git + ripgrep + pi).

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

### Wiring an app to it (e.g. SummonGhost)

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
- **Kill switch**: set `self_heal_settings.enabled` to anything but `1` in D1.
- **No-op contract**: the agent must reply `FIX` or `NOOP`; commit+push happens only on an
  explicit `FIX` verdict **and** a non-empty `git diff`.
- **Token hygiene**: the GitHub token is passed only to the clone and push steps (per-`exec`
  env), the remote URL is rewritten to public after clone, and the token never reaches the
  model's shell.

## License

MIT

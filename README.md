# self-heal

Self-healing agent for Cloudflare Workers. When your app catches an error, it POSTs a
small payload to this service; `self-heal` clones the repo, diagnoses the bug, writes a
fix, and **opens a pull request**.

The whole thing runs **inside a Worker**. No container, no sandbox, no API token for the
model. If the error is not fixable by a code change (provider outage, invalid user input,
infrastructure, non-reproducible), the agent reports `NOOP` and no branch is created.

**It never writes to your base branch.** The agent has no shell and cannot run your tests,
so the PR's CI checks are where the fix gets verified and you decide whether it merges.

## How it works

```
app error ──► POST /fix (HMAC-signed, timestamped, replay-proof)
                 │  admission control (D1): dedupe · rate limit · kill switch
                 ▼
          FixWorkflow (durable steps)
            1. clone          isomorphic-git → SQLite VFS in a Durable Object
            2. agent          AI SDK tool loop on @cf/deepseek-ai/deepseek-v4-pro-0813
            3. verdict        report_verdict tool call  +  git status  +  protected paths
            4. branch + PR    only on FIX *and* a non-empty diff *and* clean paths
            5. cleanup        drop the checkout from Durable Object storage
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

There is no shell, so the agent **cannot run the project's tests, typechecker, or build**.
It fixes from reading code alone. That is exactly why it opens a PR rather than pushing:
your existing CI runs on the diff, and a human reads it, so the verification the agent
can't do itself happens before the code merges.

The prompt leans hard on this — the agent is told it cannot verify anything and must
answer `NOOP` when it is not confident from the code it has actually read. The PR body
carries the same warning for whoever reviews it.

## Setup

```bash
pnpm install

# 1. D1 database
pnpm db:create              # prints the database_id → put it in wrangler.jsonc
pnpm db:init                # add --remote for the production database

# 2. Trigger secret (stored in Cloudflare, never on disk — piped via stdin so
#    it never lands in shell history)
openssl rand -hex 32 | wrangler secret put TRIGGER_SECRET

# 3. Deploy
pnpm deploy
```

Then create the GitHub App by visiting **`/app/setup`** on the deployed Worker. This runs
GitHub's [App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
GitHub creates the App and returns its private key *over the API* rather than as a browser
download, so the key goes from GitHub to Cloudflare without ever touching your machine.
The App requests exactly `contents: write` and `pull_requests: write`.

Two steps finish the setup:

```bash
# 4. Install the App on the repos self-heal may open PRs against
#    (the callback page links straight to it)

# 5. Move the key out of its D1 staging row into Worker secrets, then redeploy
pnpm app:promote
pnpm deploy
```

Each run then mints a fresh **installation token** that expires in an hour: there is no
standing credential capable of writing to your repositories.

`/app/setup` is single-use — while a `github_app` row exists, both setup routes return 409.

### Why the key passes through D1

A Worker cannot write its own secrets (`wrangler secret put` is a deploy-time operation),
but the manifest flow hands the key to the Worker *at runtime*. D1 is the only place the
Worker can put it in that moment.

D1 is a database, not a secret store, and
[Cloudflare's guidance](https://developers.cloudflare.com/workers/configuration/secrets/)
is that sensitive values belong in secrets or a Secrets Store binding. So the row is
**staging, not storage**: `pnpm app:promote` pipes it into `GITHUB_APP_ID` /
`GITHUB_APP_KEY` and deletes it, without the value being printed, written to a file, or
entering shell history. Until you run it, runs fail with "no github app configured" —
deliberately, so a private key cannot quietly live on in a database.

Update the `vars` in `wrangler.jsonc` (`REPO`, `DEFAULT_BRANCH`, `MODEL`, `MAX_AGENT_STEPS`).

> Deploys take a minute or so to reach every colo. Triggering a run immediately after
> `wrangler deploy` can hit a colo still serving the previous version, which surfaces as
> `The RPC receiver does not implement the method "…"`. Wait, then trigger.

## Triggering

Sign `<timestamp>.<body>` with `TRIGGER_SECRET` using HMAC-SHA256, hex-encoded. Send the
digest in `x-self-heal-signature` and the same millisecond timestamp in
`x-self-heal-timestamp`:

```bash
TS=$(date +%s%3N)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$TRIGGER_SECRET" | awk '{print $2}')
curl -X POST https://self-heal.<your-worker>.workers.dev/fix \
  -H 'content-type: application/json' \
  -H "x-self-heal-timestamp: $TS" \
  -H "x-self-heal-signature: $SIG" \
  -d "$BODY"
```

The timestamp is *inside* the signed material, so it cannot be updated without the secret.
Requests more than 5 minutes from the Worker's clock are rejected (in both directions —
future-dating would otherwise extend a captured request's usable life), and an accepted
signature is recorded so it cannot be replayed even within that window. A replay returns
`409`.

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
  const timestamp = String(Date.now());
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.TRIGGER_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signed = new TextEncoder().encode(`${timestamp}.${body}`);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, signed))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  await fetch(`${env.SELF_HEAL_URL}/fix`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-self-heal-timestamp": timestamp,
      "x-self-heal-signature": sig,
    },
    body,
  }).catch(() => {});
}
```

## Safety & cost controls

- **HMAC auth** on every trigger (shared `TRIGGER_SECRET`), over `<timestamp>.<body>` with a
  5-minute window, and each accepted signature is recorded so it cannot be replayed.
- **Dedup**: one run per fingerprint at a time; a `fixed` fingerprint is quiet for
  `COOLDOWN_HOURS` (default 24h).
- **Rate limit**: `MAX_RUNS_PER_HOUR` (default 5) global budget.
- **Step ceiling**: `MAX_AGENT_STEPS` (default 24) bounds tool-call rounds per run.
- **Kill switch**: set `self_heal_settings.enabled` to anything but `1` in D1.
- **Never touches the base branch**: work is pushed to a fresh `self-heal/<id>-<error>`
  branch and offered as a PR. Merging is always a human decision.
- **No-op contract**: the agent must reply `FIX` or `NOOP`; a branch is created only on an
  explicit `FIX` verdict **and** a non-empty `git status`.
- **Protected paths**: a change touching `.git/`, `.github/`, a lockfile, or `.env*` is
  rejected outright (outcome `blocked`) rather than proposed.
- **No standing GitHub credential**: self-heal authenticates as a GitHub App and mints a
  one-hour installation token per run, scoped to the installed repos and to
  `contents`/`pull_requests`. The token is passed to the Durable Object's git methods and
  used there only — never written into `.git/config` (auth goes in an HTTP header, not the
  remote URL) and never into the workspace filesystem, so the model's file tools cannot
  read it. It is also minted *outside* `step.do`, because Workflows durably persist step
  return values and would otherwise write the token into the instance record.
- **Structural verdict**: the agent ends its turn by calling a `report_verdict` tool with a
  typed `fix`/`noop`, rather than by emitting a text marker. A model that stops without
  calling it yields no verdict at all instead of an ambiguous one.

## License

MIT

import { type Env, intVar } from "./env";
import { convertManifest } from "./github";
import { verifySignature } from "./hmac";

export { FixAgent } from "./agent";
export { FixWorkflow } from "./workflow";

type FixRequest = {
  errorName: string;
  message?: string;
  component?: string;
  operation?: string;
  stack?: string;
  repo?: string;
  branch?: string;
  fingerprint?: string;
};

const MAX_BODY_BYTES = 64 * 1024;

type Admission =
  | { ok: true; runId: string }
  | { ok: false; reason: string; code: string; status: number };

async function admit(env: Env, input: {
  fingerprint: string;
  repo: string;
  branch: string;
}): Promise<Admission> {
  const cooldownMs = intVar(env.COOLDOWN_HOURS, 24) * 3_600_000;
  const maxPerHour = intVar(env.MAX_RUNS_PER_HOUR, 5);
  const since = Date.now() - 3_600_000;

  // The three admission reads are independent, so they go in one batch rather
  // than three sequential round trips. This runs on the error path of a
  // production app, so the latency is paid while that app is already unhappy.
  const [settings, history, hourly] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare("SELECT value FROM self_heal_settings WHERE key = 'enabled'"),
    env.DB
      .prepare(
        "SELECT id, status, outcome, created_at FROM fix_runs WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1",
      )
      .bind(input.fingerprint),
    env.DB.prepare("SELECT COUNT(*) AS c FROM fix_runs WHERE created_at > ?").bind(since),
  ]);

  const enabled = settings.results[0] as { value: string } | undefined;
  if (enabled && enabled.value !== "1") {
    return { ok: false, reason: "self-heal is disabled", code: "disabled", status: 503 };
  }

  const recent = history.results[0] as
    | { id: string; status: string; outcome: string | null; created_at: number }
    | undefined;

  if (recent && (recent.status === "queued" || recent.status === "running")) {
    return { ok: false, reason: "a fix is already in progress for this error", code: "in_progress", status: 409 };
  }
  // A proposed fix suppresses repeats for the cooldown window, otherwise a
  // recurring error opens a duplicate PR every time it fires. ("fixed" is the
  // pre-PR-mode outcome name, kept so old rows still suppress.)
  const settled = recent?.outcome === "proposed" || recent?.outcome === "fixed";
  if (recent && settled && Date.now() - recent.created_at < cooldownMs) {
    return {
      ok: false,
      reason: "a fix for this error was proposed recently",
      code: "recently_proposed",
      status: 200,
    };
  }

  const count = hourly.results[0] as { c: number } | undefined;
  if ((count?.c ?? 0) >= maxPerHour) {
    return { ok: false, reason: "hourly run budget exhausted", code: "rate_limited", status: 429 };
  }

  const runId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO fix_runs (id, fingerprint, repo, branch, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)",
  )
    .bind(runId, input.fingerprint, input.repo, input.branch, Date.now())
    .run();
  return { ok: true, runId };
}

/**
 * Record a signature as used, returning false if it has been seen before.
 *
 * The timestamp window makes a captured request useless after a few minutes;
 * this makes it useless immediately. `INSERT OR IGNORE` plus a primary-key
 * collision does the check and the claim in one statement, so two concurrent
 * replays cannot both pass — a read-then-write would race.
 *
 * Expired rows are pruned in the same batch, since nothing outside the window
 * can be replayed anyway.
 */
async function claimSignature(env: Env, signature: string, expiresAt: number): Promise<boolean> {
  const [claim] = await env.DB.batch([
    env.DB
      .prepare("INSERT OR IGNORE INTO seen_signatures (signature, expires_at) VALUES (?, ?)")
      .bind(signature, expiresAt),
    env.DB.prepare("DELETE FROM seen_signatures WHERE expires_at < ?").bind(Date.now()),
  ]);
  return (claim.meta?.changes ?? 0) > 0;
}

/**
 * GitHub App manifest flow.
 *
 * `/app/setup` renders a self-submitting form that POSTs an App manifest to
 * GitHub; GitHub redirects back to `/app/callback?code=…`, which exchanges the
 * code for the App's id and private key and stores them in D1. The key is
 * returned over the API rather than downloaded, so it goes from GitHub to
 * Cloudflare without ever landing on a developer machine.
 *
 * Single-use by construction: once a row exists, both routes stop working.
 */
async function handleAppSetup(url: URL, env: Env): Promise<Response> {
  const existing = await env.DB.prepare("SELECT slug FROM github_app WHERE id = 1").first<{
    slug: string;
  }>();
  if (existing) {
    return Response.json(
      {
        error: "a github app is already configured",
        slug: existing.slug,
        hint: "delete the github_app row in D1 to re-run setup",
      },
      { status: 409 },
    );
  }

  if (url.pathname === "/app/setup") {
    const manifest = {
      name: `self-heal-${crypto.randomUUID().slice(0, 8)}`,
      url: "https://github.com/ferdousbhai/self-heal",
      redirect_url: `${url.origin}/app/callback`,
      public: false,
      default_permissions: { contents: "write", pull_requests: "write" },
      default_events: [],
    };
    const html = `<!doctype html><meta charset="utf-8"><title>self-heal setup</title>
<body style="font-family:system-ui;padding:2rem">
<p>Redirecting to GitHub to create the self-heal App…</p>
<form id="f" method="post" action="https://github.com/settings/apps/new">
<input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&apos;")}'>
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("f").submit()</script>
</body>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const code = url.searchParams.get("code");
  if (!code) return Response.json({ error: "missing code" }, { status: 400 });

  const app = await convertManifest(code);
  await env.DB.prepare(
    "INSERT INTO github_app (id, app_id, slug, private_key, created_at) VALUES (1, ?, ?, ?, ?)",
  )
    .bind(app.appId, app.slug, app.privateKey, Date.now())
    .run();

  return new Response(
    `<!doctype html><meta charset="utf-8"><title>self-heal setup</title>
<body style="font-family:system-ui;padding:2rem;line-height:1.6">
<h1>✅ GitHub App created</h1>
<p><b>${app.slug}</b> (id ${app.appId}). The private key was stored in D1 and never touched your machine.</p>
<p>Last step — install it on the repositories self-heal may open pull requests against:</p>
<p><a href="${app.htmlUrl}/installations/new" style="font-size:1.2rem">Install ${app.slug} →</a></p>
</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // Booleans only — never the values. `staged` being true means /app/setup
      // ran but `pnpm app:promote` did not, so a private key is still sitting
      // in D1 and runs will refuse to start.
      const staged = await env.DB.prepare("SELECT 1 AS n FROM github_app WHERE id = 1").first<{
        n: number;
      }>();
      const configured = Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_KEY);
      return Response.json({
        ok: configured && !staged,
        githubApp: configured ? "configured" : "missing",
        stagedKeyInD1: Boolean(staged),
        ...(staged ? { action: "run `pnpm app:promote` to move the key into Worker secrets" } : {}),
        ...(configured ? {} : { action: "visit /app/setup" }),
      });
    }

    // One-time GitHub App setup (manifest flow). Both routes refuse to run
    // once credentials exist, so they cannot be used to replace the App.
    if (url.pathname === "/app/setup" || url.pathname === "/app/callback") {
      return handleAppSetup(url, env);
    }

    if (url.pathname !== "/fix" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return Response.json({ error: "body too large" }, { status: 413 });
    }

    const verified = await verifySignature(
      env.TRIGGER_SECRET,
      raw,
      request.headers.get("x-self-heal-signature"),
      request.headers.get("x-self-heal-timestamp"),
    );
    if (!verified.ok) {
      // The reason is logged, not returned: distinguishing "bad signature"
      // from "stale timestamp" for an unauthenticated caller is free
      // information about how to craft the next attempt.
      console.warn("[self-heal] rejected trigger", { reason: verified.reason });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!(await claimSignature(env, verified.signature, verified.expiresAt))) {
      return Response.json({ error: "replayed request" }, { status: 409 });
    }

    let body: FixRequest;
    try {
      body = JSON.parse(raw) as FixRequest;
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    if (!body.errorName || typeof body.errorName !== "string") {
      return Response.json({ error: "errorName is required" }, { status: 400 });
    }

    const repo = (body.repo || env.REPO || "").trim();
    const branch = (body.branch || env.DEFAULT_BRANCH || "main").trim();
    if (!repo.includes("/")) {
      return Response.json({ error: "repo must be owner/name" }, { status: 400 });
    }

    const component = body.component ?? "";
    const operation = body.operation ?? "";
    const fingerprint = body.fingerprint
      || `${repo}|${component}|${operation}|${body.errorName}`;

    const admission = await admit(env, { fingerprint, repo, branch });
    if (!admission.ok) {
      return Response.json(
        { error: admission.reason, code: admission.code },
        { status: admission.status },
      );
    }

    await env.FIX_WORKFLOW.create({
      id: admission.runId,
      params: {
        runId: admission.runId,
        repo,
        branch,
        errorName: body.errorName,
        component,
        operation,
        message: body.message,
        stack: body.stack,
      },
    });

    return Response.json({ ok: true, runId: admission.runId }, { status: 202 });
  },
} satisfies ExportedHandler<Env>;

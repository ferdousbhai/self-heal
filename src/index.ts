import { type Env, intVar } from "./env";
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
  const enabled = await env.DB.prepare(
    "SELECT value FROM self_heal_settings WHERE key = 'enabled'",
  ).first<{ value: string }>();
  if (enabled && enabled.value !== "1") {
    return { ok: false, reason: "self-heal is disabled", code: "disabled", status: 503 };
  }

  const cooldownMs = intVar(env.COOLDOWN_HOURS, 24) * 3_600_000;
  const maxPerHour = intVar(env.MAX_RUNS_PER_HOUR, 5);

  const recent = await env.DB.prepare(
    "SELECT id, status, outcome, created_at FROM fix_runs WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(input.fingerprint).first<{
    id: string;
    status: string;
    outcome: string | null;
    created_at: number;
  }>();

  if (recent && (recent.status === "queued" || recent.status === "running")) {
    return { ok: false, reason: "a fix is already in progress for this error", code: "in_progress", status: 409 };
  }
  if (recent && recent.outcome === "fixed" && Date.now() - recent.created_at < cooldownMs) {
    return { ok: false, reason: "this error was fixed recently", code: "recently_fixed", status: 200 };
  }

  const since = Date.now() - 3_600_000;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM fix_runs WHERE created_at > ?",
  ).bind(since).first<{ c: number }>();
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (url.pathname !== "/fix" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return Response.json({ error: "body too large" }, { status: 413 });
    }

    const signature = request.headers.get("x-self-heal-signature");
    if (!(await verifySignature(env.TRIGGER_SECRET, raw, signature))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
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

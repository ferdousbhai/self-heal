/**
 * HMAC-SHA256 request authentication with replay protection.
 *
 * The caller signs `${timestamp}.${body}` with the shared TRIGGER_SECRET and
 * sends the hex digest in `x-self-heal-signature`, with the same timestamp in
 * `x-self-heal-timestamp`.
 *
 * Signing the body alone would authenticate *who* sent a request but not
 * *when*, so a captured request could be replayed verbatim forever. Binding
 * the timestamp into the signed material means a replay must reuse the
 * original timestamp — which then falls outside the acceptance window.
 *
 * The window bounds the attack rather than eliminating it; `claimSignature`
 * in index.ts closes the remainder by refusing a signature that has already
 * been seen.
 */

/** How far a request's timestamp may be from ours. Covers clock skew. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export type Verification =
  | { ok: true; signature: string; expiresAt: number }
  | { ok: false; reason: string };

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifySignature(
  secret: string,
  body: string,
  signature: string | null,
  timestamp: string | null,
  now = Date.now(),
): Promise<Verification> {
  if (!signature || !timestamp) return { ok: false, reason: "missing signature or timestamp" };

  const sentAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "malformed timestamp" };
  // Checked in both directions: a future-dated timestamp would otherwise
  // extend a captured request's usable lifetime arbitrarily.
  if (Math.abs(now - sentAt) > REPLAY_WINDOW_MS) return { ok: false, reason: "timestamp outside window" };

  const expected = await sign(secret, timestamp, body);
  if (!timingSafeEqual(expected, signature)) return { ok: false, reason: "bad signature" };

  return { ok: true, signature: expected, expiresAt: sentAt + REPLAY_WINDOW_MS };
}

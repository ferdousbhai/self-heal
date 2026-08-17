/**
 * GitHub App authentication.
 *
 * self-heal authenticates as a GitHub App rather than with a personal access
 * token: it signs a short-lived JWT with the App's private key, exchanges it
 * for an *installation token* scoped to the target repository, and uses that.
 * Installation tokens expire in an hour, so no standing credential capable of
 * writing to your repositories exists anywhere.
 *
 * The App's credentials arrive through the manifest flow (see `/app/setup` in
 * index.ts) and live in D1. They are written once by Cloudflare and read only
 * by this Worker — they never touch a developer machine.
 */

export type AppCredentials = { appId: string; privateKey: string };

const API = "https://api.github.com";

function apiHeaders(auth: string): Record<string, string> {
  return {
    Authorization: `Bearer ${auth}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub rejects API requests that omit it.
    "User-Agent": "self-heal",
  };
}

function base64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const raw =
    typeof bytes === "string"
      ? bytes
      : String.fromCharCode(...new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** DER type-length-value wrapper with long-form lengths. */
function der(tag: number, content: Uint8Array): Uint8Array {
  const header: number[] = [tag];
  if (content.length < 0x80) {
    header.push(content.length);
  } else {
    const size: number[] = [];
    for (let n = content.length; n > 0; n >>= 8) size.unshift(n & 0xff);
    header.push(0x80 | size.length, ...size);
  }
  const out = new Uint8Array(header.length + content.length);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

/**
 * Wrap a PKCS#1 RSA key in a PKCS#8 PrivateKeyInfo. GitHub issues PKCS#1
 * (`BEGIN RSA PRIVATE KEY`); WebCrypto's importKey only accepts PKCS#8.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  // AlgorithmIdentifier: rsaEncryption (1.2.840.113549.1.1.1), NULL params.
  const algorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const key = der(0x04, pkcs1);
  const body = new Uint8Array(version.length + algorithm.length + key.length);
  body.set(version, 0);
  body.set(algorithm, version.length);
  body.set(key, version.length + algorithm.length);
  return der(0x30, body);
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

/** Sign the App JWT (RS256, ≤10 min per GitHub's limit). */
async function appJwt({ appId, privateKey }: AppCredentials): Promise<string> {
  const der = pemToDer(privateKey);
  const pkcs8 = privateKey.includes("BEGIN RSA PRIVATE KEY") ? pkcs1ToPkcs8(der) : der;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as unknown as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  // Backdate `iat` to tolerate clock skew between Cloudflare and GitHub.
  const claims = { iat: now - 60, exp: now + 540, iss: appId };
  const signingInput = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify(claims),
  )}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Mint an installation token for `owner/repo`. Scoped to the repositories the
 * App is installed on and valid for one hour.
 */
export async function installationToken(
  credentials: AppCredentials,
  repo: string,
): Promise<string> {
  const jwt = await appJwt(credentials);

  const installation = await fetch(`${API}/repos/${repo}/installation`, {
    headers: apiHeaders(jwt),
  });
  if (!installation.ok) {
    throw new Error(
      `github app is not installed on ${repo} (${installation.status}) — install it at https://github.com/settings/installations`,
    );
  }
  const { id } = (await installation.json()) as { id: number };

  const minted = await fetch(`${API}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: apiHeaders(jwt),
  });
  const payload = (await minted.json()) as { token?: string; message?: string };
  if (!minted.ok || !payload.token) {
    throw new Error(`github ${minted.status}: ${payload.message ?? "no installation token"}`);
  }
  return payload.token;
}

/**
 * Exchange a manifest-flow code for the App's credentials. This is the step
 * that keeps the private key off disk: GitHub returns it here rather than as
 * a browser download.
 */
export async function convertManifest(
  code: string,
): Promise<AppCredentials & { slug: string; htmlUrl: string }> {
  const response = await fetch(`${API}/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "self-heal",
    },
  });
  const payload = (await response.json()) as {
    id?: number;
    slug?: string;
    pem?: string;
    html_url?: string;
    message?: string;
  };
  if (!response.ok || !payload.pem || !payload.id) {
    throw new Error(`github ${response.status}: ${payload.message ?? "manifest conversion failed"}`);
  }
  return {
    appId: String(payload.id),
    privateKey: payload.pem,
    slug: payload.slug ?? "self-heal",
    htmlUrl: payload.html_url ?? "",
  };
}

/**
 * Verification of the signed identity assertion an identity-aware proxy puts on each request it has
 * authenticated. Provider-agnostic: it takes a JWKS URL, an issuer and an audience, so Cloudflare
 * Access, Pomerium, oauth2-proxy and anything else emitting a JWS behave identically here.
 *
 * The proxy is never trusted on its say-so. Any client that reached the origin directly could set
 * the same header, so without a signature check one misrouted hostname becomes an unauthenticated
 * admin session. This module is what makes the header worth reading at all.
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from "crypto";

/**
 * Accepted JWS algorithms. The set is closed deliberately: `alg` is attacker-controlled — it lives
 * in the token's own header — so honouring whatever it names is exactly how "none" and
 * HMAC-with-the-public-key confusion get in. `keyType` is checked too, so an RS* header cannot be
 * verified against an EC key or the reverse.
 */
const ALGORITHMS: Record<string, { hash: string; keyType: string; options?: { dsaEncoding: "ieee-p1363" } }> = {
  RS256: { hash: "sha256", keyType: "rsa" },
  RS384: { hash: "sha384", keyType: "rsa" },
  RS512: { hash: "sha512", keyType: "rsa" },
  ES256: { hash: "sha256", keyType: "ec", options: { dsaEncoding: "ieee-p1363" } },
  ES384: { hash: "sha384", keyType: "ec", options: { dsaEncoding: "ieee-p1363" } },
  ES512: { hash: "sha512", keyType: "ec", options: { dsaEncoding: "ieee-p1363" } },
};

const DEFAULT_CLOCK_SKEW_MS = 60_000;
const DEFAULT_MIN_REFRESH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

async function fetchJwksDocument(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`JWKS endpoint returned ${res.status}`);
  return res.json();
}

function parseKeys(doc: unknown): Map<string, KeyObject> {
  const keys = (doc as { keys?: unknown } | null)?.keys;
  const parsed = new Map<string, KeyObject>();
  if (!Array.isArray(keys)) return parsed;
  for (const jwk of keys) {
    const kid = (jwk as { kid?: unknown } | null)?.kid;
    if (typeof kid !== "string" || !kid) continue;
    try {
      parsed.set(kid, createPublicKey({ key: jwk as never, format: "jwk" }));
    } catch {
      continue; // one unusable entry must not discard the rest of the set
    }
  }
  return parsed;
}

/** The provider's signing keys, cached because verification runs synchronously on every request. */
export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private lastAttempt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly minRefreshMs = DEFAULT_MIN_REFRESH_MS,
    private readonly fetchDocument: (url: string) => Promise<unknown> = fetchJwksDocument,
  ) {}

  get size(): number {
    return this.keys.size;
  }

  /** Replaces the cached set. Throws on an unreachable or empty endpoint so startup can fail closed. */
  async refresh(): Promise<void> {
    const parsed = parseKeys(await this.fetchDocument(this.url));
    if (parsed.size === 0) throw new Error(`JWKS at ${this.url} contained no usable keys`);
    this.keys = parsed;
    this.lastAttempt = Date.now();
  }

  /**
   * Cached lookup. A miss schedules a refresh and fails this request rather than awaiting one: an
   * unknown `kid` is precisely what an attacker sends to turn each request into an outbound fetch,
   * and the rate limit bounds that to one per window. Genuine key rotation costs one failed request.
   */
  find(kid: string): KeyObject | undefined {
    const key = this.keys.get(kid);
    if (key) return key;
    this.scheduleRefresh();
    return undefined;
  }

  private scheduleRefresh(): void {
    if (this.refreshing || Date.now() - this.lastAttempt < this.minRefreshMs) return;
    this.lastAttempt = Date.now();
    this.refreshing = this.refresh()
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = null;
      });
  }
}

export type AssertionPolicy = {
  issuer: string;
  audience: string;
  jwks: JwksCache;
  clockSkewMs?: number;
};

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// `aud` is a string or an array of them; either must contain this instance's value exactly.
function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.some((entry) => entry === expected);
}

function withinValidity(claims: Record<string, unknown>, now: number, skewMs: number): boolean {
  const { exp, nbf } = claims;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
  if (exp * 1000 + skewMs <= now) return false;
  if (nbf === undefined) return true;
  if (typeof nbf !== "number" || !Number.isFinite(nbf)) return false;
  return nbf * 1000 - skewMs <= now;
}

/**
 * True only when the token is a well-formed JWS signed by a currently published key, issued by the
 * configured provider, addressed to this instance and inside its validity window. Every other
 * shape — including a missing `exp` and an unknown `kid` — is false, so callers fail closed.
 *
 * The audience check is what isolates one deployment from another behind a shared provider: without
 * it, a token minted for any application of the same issuer authenticates here.
 */
export function verifyAssertion(token: string, policy: AssertionPolicy, now = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [rawHeader, rawPayload, rawSignature] = parts;

  const header = decodeJson(rawHeader);
  if (!header || typeof header.kid !== "string" || typeof header.alg !== "string") return false;
  const algorithm = ALGORITHMS[header.alg];
  if (!algorithm) return false;

  const key = policy.jwks.find(header.kid);
  if (!key || key.asymmetricKeyType !== algorithm.keyType) return false;

  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, "ascii");
  const signature = Buffer.from(rawSignature, "base64url");
  if (!verifySignature(algorithm.hash, signed, { key, ...algorithm.options }, signature)) return false;

  const claims = decodeJson(rawPayload);
  if (!claims || claims.iss !== policy.issuer) return false;
  if (!audienceMatches(claims.aud, policy.audience)) return false;
  return withinValidity(claims, now, policy.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS);
}

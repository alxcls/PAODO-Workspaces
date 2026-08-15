// Request authentication and CSRF logic for the custom HTTP server (server.ts).
//
// Kept out of server.ts so the security-critical pieces — timing-safe Basic-Auth comparison,
// failure-based blocking and the CSRF guard — are unit-testable in
// isolation rather than welded to the process entry point. server.ts is a thin adapter that
// extracts primitives off the Node request and calls these functions.
import type { IncomingMessage } from "http";
import { timingSafeEqual } from "crypto";
import { isPlatformRouteAllowed } from "./platformAccessPolicy";

// Constant-time string comparison. Used for the Basic-Auth username/password so a byte-by-byte
// timing difference can't be measured to recover the secret.
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.byteLength !== bBuf.byteLength) {
    // dummy compare to avoid length-based timing oracle
    timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

// Tracks per-IP Basic-Auth failures and blocks an IP once it exceeds `max` failures within
// `windowMs`. In-memory, reset when the window elapses. A successful auth clears the IP.
export class AuthFailureTracker {
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max = 5,
    private windowMs = 60_000,
  ) {}

  isBlocked(ip: string): boolean {
    const entry = this.failures.get(ip);
    if (!entry || Date.now() > entry.resetAt) return false;
    return entry.count >= this.max;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const entry = this.failures.get(ip);
    if (!entry || now > entry.resetAt) {
      this.failures.set(ip, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }

  clear(ip: string): void {
    this.failures.delete(ip);
  }
}

// The agent endpoint authenticates via Bearer API key, not Basic Auth — exempt POSTs to it.
const PUBLIC_API_RE = /^\/api\/workspaces\/[^/]+\/agent$/;
// The Workspace MCP endpoint authenticates via its own Bearer secret (credentialStore's
// "workspace-mcp" kind), not Basic
// Auth, so exempt every method here. POST is the protocol channel: the route validates the secret
// and returns 401 on failure. GET/DELETE carry no secret and the route rejects them with 405 before
// any workspace state is touched, so exempting them leaks nothing.
const PUBLIC_MCP_RE = /^\/api\/workspaces\/[^/]+\/mcp$/;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// "ok" means Basic UI credentials were verified; "platform" means an instance token was verified
// for this exact method/path. "exempt" is reserved for agent/MCP routes that validate their own
// credential inside the route. Only "ok" may mint a browser session cookie.
export type AuthResult = "ok" | "platform" | "exempt" | "challenge" | "unauthorized" | "blocked";
export type AuthCredentials = { user: string; pass: string };
// Takes only the secret: the platform credential is instance-wide, and the route allowlist decides
// what it may reach.
export type PlatformTokenValidator = (plain: string) => boolean;

type RequestHostHeaders = {
  host?: string | string[];
  "x-forwarded-host"?: string | string[];
};

export type RequestHostValidation =
  | { ok: true; hostname: string }
  | {
      ok: false;
      reason: "host_missing" | "host_malformed" | "host_untrusted" | "forwarded_host_malformed" | "host_mismatch";
    };

/**
 * Normalize an HTTP authority to a hostname. Ports are intentionally ignored: they are transport
 * details, while the hostname is the security boundary. URL parsing also canonicalizes case,
 * trailing dots, IDNs and bracketed IPv6 without accepting paths, credentials or header lists.
 */
function normalizeHostname(value: string): string | null {
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.includes(",") ||
    /[\s/@\\?#]/.test(candidate) ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return null;
  }
  try {
    const parsed = new URL(`http://${candidate}`);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/") return null;
    return parsed.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

function singleHeader(value: string | string[] | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value;
}

/** Build the deployment's hostname allowlist. A malformed configured hostname is a startup error. */
type TrustedHostEnvironment = {
  PAODO_TRUSTED_HOSTS?: string;
  WORKSPACE_API_DOMAIN?: string;
};

export function trustedRequestHosts(
  env: TrustedHostEnvironment = {
    PAODO_TRUSTED_HOSTS: process.env.PAODO_TRUSTED_HOSTS,
    WORKSPACE_API_DOMAIN: process.env.WORKSPACE_API_DOMAIN,
  },
): ReadonlySet<string> {
  const configured = ["localhost", "127.0.0.1", "[::1]", "app"];
  if (env.WORKSPACE_API_DOMAIN?.trim()) configured.push(env.WORKSPACE_API_DOMAIN.trim());
  if (env.PAODO_TRUSTED_HOSTS?.trim()) {
    configured.push(...env.PAODO_TRUSTED_HOSTS.split(",").map((host) => host.trim()));
  }

  const trusted = new Set<string>();
  for (const configuredHost of configured) {
    const hostname = normalizeHostname(configuredHost);
    if (!hostname) throw new Error(`invalid trusted hostname: ${JSON.stringify(configuredHost)}`);
    trusted.add(hostname);
  }
  return trusted;
}

/**
 * Reject Host-header poisoning before authentication or Next.js routing. A proxy may omit
 * X-Forwarded-Host; if it sends one, it must be one canonical value and agree with Host.
 */
export function validateRequestHost(
  headers: RequestHostHeaders,
  trustedHosts: ReadonlySet<string>,
): RequestHostValidation {
  const rawHost = singleHeader(headers.host);
  if (rawHost === undefined) return { ok: false, reason: "host_missing" };
  if (rawHost === null) return { ok: false, reason: "host_malformed" };
  const hostname = normalizeHostname(rawHost);
  if (!hostname) return { ok: false, reason: "host_malformed" };
  if (!trustedHosts.has(hostname)) return { ok: false, reason: "host_untrusted" };

  const rawForwardedHost = singleHeader(headers["x-forwarded-host"]);
  if (rawForwardedHost === null) return { ok: false, reason: "forwarded_host_malformed" };
  if (rawForwardedHost !== undefined) {
    const forwardedHostname = normalizeHostname(rawForwardedHost);
    if (!forwardedHostname) return { ok: false, reason: "forwarded_host_malformed" };
    if (forwardedHostname !== hostname || !trustedHosts.has(forwardedHostname)) {
      return { ok: false, reason: "host_mismatch" };
    }
  }
  return { ok: true, hostname };
}

// The primitives checkAuth/isCsrf need off a request — extracted so the core logic never touches
// Node's http types and can be unit-tested with plain objects.
export type AuthRequest = { method: string; pathname: string; authorization: string; cookie: string };

export function authRequestFromIncoming(req: IncomingMessage): AuthRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  return {
    method: req.method ?? "GET",
    pathname: url.pathname,
    authorization: req.headers["authorization"] ?? "",
    cookie: req.headers["cookie"] ?? "",
  };
}

// Extracts the client IP. Cloudflare sets cf-connecting-ip at its edge and overwrites whatever the
// client sent, so it is the one forwarded address this deployment can trust; x-real-ip and
// x-forwarded-for are set by nothing in the chain, which means a client picks their own value. That
// matters because this address is written to the audit trail and keys the brute-force lockout: a
// forgeable value is both a poisoned record and a lockout an attacker steps around by rotating a
// header. Falls back to the socket peer (the Docker gateway in production — useless for attribution,
// but never a lie). Distinct from realtime/clientIp.ts, which reads a NextRequest.
export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["cf-connecting-ip"];
  if (typeof forwarded === "string" && forwarded) return forwarded;
  return req.socket.remoteAddress ?? "unknown";
}

export function checkAuth(
  ip: string,
  req: AuthRequest,
  credentials: AuthCredentials,
  tracker: AuthFailureTracker,
  validatePlatformToken: PlatformTokenValidator = () => false,
): AuthResult {
  // Must reject before the comparison below: safeEqual("", "") is true, so `Basic Og==` would
  // authenticate against unset credentials. server.ts also refuses to boot without them.
  if (!credentials.user || !credentials.pass) return "unauthorized";
  if (tracker.isBlocked(ip)) return "blocked";

  // The agent endpoint authenticates via Bearer API key — exempt it from basic auth.
  if (req.method === "POST" && PUBLIC_API_RE.test(req.pathname)) return "exempt";
  // The Workspace MCP endpoint authenticates via its own Bearer secret — exempt all methods.
  if (PUBLIC_MCP_RE.test(req.pathname)) return "exempt";

  const auth = req.authorization;
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);

    // Authentication first, and it is the only thing that feeds the brute-force tracker: a bad secret
    // is a credential guess.
    if (!validatePlatformToken(token)) {
      tracker.recordFailure(ip);
      return "unauthorized";
    }

    // Authorization second, and deliberately NOT a tracked failure. Default-deny: a route with no
    // mapped permission never accepts the platform credential, so adding a UI route cannot silently
    // create a programmatic capability. Counting these would be wrong and actively harmful — the
    // tracker is shared with the UI's Basic auth, so a misconfigured script polling an unshared route
    // would lock its own operator out of the web interface after five requests.
    if (!isPlatformRouteAllowed(req.method, req.pathname)) return "unauthorized";

    tracker.clear(ip);
    return "platform";
  }

  if (!auth.startsWith("Basic ")) {
    // No credentials sent — normal browser challenge-response handshake, not an attack
    return "challenge";
  }

  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  if (colon === -1) {
    tracker.recordFailure(ip);
    return "unauthorized";
  }

  const userOk = safeEqual(decoded.slice(0, colon), credentials.user);
  const passOk = safeEqual(decoded.slice(colon + 1), credentials.pass);

  if (userOk && passOk) {
    tracker.clear(ip);
    return "ok";
  }

  tracker.recordFailure(ip);
  return "unauthorized";
}

// Auth for the /ws upgrade. Basic is tried first so Chrome and Firefox — which do reuse the cached
// credentials on a same-origin handshake — keep authenticating exactly as before, and so a failed
// Basic attempt still feeds the brute-force tracker. The session cookie is the fallback for browsers
// that send no Authorization at all on an upgrade (WebKit); it is minted only after Basic succeeded
// on an earlier HTTP request, so it proves the same thing one hop removed.
//
// Neither "platform" nor "exempt" is accepted here: those credentials are HTTP-only.
export function checkWsAuth(
  ip: string,
  req: AuthRequest,
  credentials: AuthCredentials,
  tracker: AuthFailureTracker,
  verifyCookie: (cookieHeader: string) => boolean,
): AuthResult {
  const result = checkAuth(ip, req, credentials, tracker);
  if (result === "ok" || result === "blocked") return result;
  return verifyCookie(req.cookie) ? "ok" : result;
}

// CSRF guard: browsers attach cached Basic Auth to cross-origin requests too. Browsers always send
// Sec-Fetch-Site; reject cross-site mutations. Requests without the header (non-browser clients,
// e.g. the external agent API using Bearer) are allowed.
export function isCsrf(req: { method: string; pathname: string; secFetchSite: string | undefined }): boolean {
  if (!MUTATING_METHODS.has(req.method)) return false;
  if (!req.pathname.startsWith("/api/")) return false;
  const site = req.secFetchSite;
  if (typeof site !== "string") return false; // non-browser client
  return site !== "same-origin" && site !== "none";
}

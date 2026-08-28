/**
 * Request authentication and CSRF logic for the custom HTTP server (server.ts).
 *
 * Kept out of server.ts so the security-critical pieces — failure-based blocking, the platform-token
 * route gate and the CSRF guard — are unit-testable in isolation rather than welded to the process
 * entry point. server.ts is a thin adapter that extracts primitives off the Node request.
 *
 * How a browser proves who it is belongs to uiAuth.ts, not here: this module takes a
 * UiAuthenticator and never learns whether the deployment runs on a shared password or behind an
 * identity-aware proxy.
 */
import type { IncomingMessage } from "http";
import { isPlatformRouteAllowed } from "./platformAccessPolicy";
import { isLoopbackAddress } from "./rateLimit";
import { runtimeMode } from "../runtimeMode";
import type { UiAuthenticator } from "./uiAuth";

// Tracks per-IP credential failures and blocks an IP once it exceeds `max` failures within
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

// "ok" means the deployment's UI credential was verified; "platform" means an instance token was
// verified for this exact method/path. "exempt" is reserved for agent/MCP routes that validate their
// own credential inside the route. Only "ok" may mint a browser session cookie.
export type AuthResult = "ok" | "platform" | "exempt" | "challenge" | "unauthorized" | "blocked";
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

type TrustedHostEnvironment = {
  PAODO_TRUSTED_HOSTS?: string;
  WORKSPACE_API_DOMAIN?: string;
};

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function normalizeAll(configured: readonly string[], label: string): Set<string> {
  const normalized = new Set<string>();
  for (const host of configured) {
    const hostname = normalizeHostname(host);
    if (!hostname) throw new Error(`invalid ${label}: ${JSON.stringify(host)}`);
    normalized.add(hostname);
  }
  return normalized;
}

function publicUiHosts(env: TrustedHostEnvironment): string[] {
  const raw = env.PAODO_TRUSTED_HOSTS?.trim();
  return raw ? raw.split(",").map((host) => host.trim()) : [];
}

/** Build the deployment's hostname allowlist. A malformed configured hostname is a startup error. */
export function trustedRequestHosts(
  env: TrustedHostEnvironment = {
    PAODO_TRUSTED_HOSTS: process.env.PAODO_TRUSTED_HOSTS,
    WORKSPACE_API_DOMAIN: process.env.WORKSPACE_API_DOMAIN,
  },
): ReadonlySet<string> {
  const configured = [...LOOPBACK_HOSTS, "app", ...publicUiHosts(env)];
  if (env.WORKSPACE_API_DOMAIN?.trim()) configured.push(env.WORKSPACE_API_DOMAIN.trim());
  return normalizeAll(configured, "trusted hostname");
}

/**
 * Hostnames a /ws handshake may come from. Not trustedRequestHosts: loopback and "app" have to be
 * trusted as a Host but never as an origin, or any local page opens an authenticated socket.
 */
export function trustedRequestOrigins(
  env: TrustedHostEnvironment = { PAODO_TRUSTED_HOSTS: process.env.PAODO_TRUSTED_HOSTS },
  dev = runtimeMode.hotReload,
): ReadonlySet<string> {
  // Loopback only while no public hostname is declared: declaring one is the edit validateRequestHost
  // already forced, so the safe set needs no second step. NODE_ENV can't tell — compose builds prod.
  const declared = publicUiHosts(env);
  const configured = dev || declared.length === 0 ? [...declared, ...LOOPBACK_HOSTS] : declared;
  return normalizeAll(configured, "trusted origin hostname");
}

/**
 * The public API/MCP gateway hostname, normalized, or null when this deployment runs no such gateway.
 * On that host the shared UI credential is not an identity — only machine tokens and self-validating
 * agent/MCP routes may pass. A malformed value is a startup error, mirroring trustedRequestHosts.
 */
export function apiRequestHost(
  env: { WORKSPACE_API_DOMAIN?: string } = { WORKSPACE_API_DOMAIN: process.env.WORKSPACE_API_DOMAIN },
): string | null {
  const configured = env.WORKSPACE_API_DOMAIN?.trim();
  if (!configured) return null;
  const hostname = normalizeHostname(configured);
  if (!hostname) throw new Error(`invalid WORKSPACE_API_DOMAIN: ${JSON.stringify(configured)}`);
  return hostname;
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

/**
 * Reject a WebSocket upgrade that another site started. A handshake is not covered by the same-origin
 * policy: the browser attaches whatever credential it holds for this host and, unlike a fetch, hands
 * the calling page a readable channel — so without this check any page that knows a workspace id can
 * silently read a live agent session. Origin is set by the browser and script cannot forge it.
 *
 * Absent is refused rather than waved through as a non-browser client, because nothing but a browser
 * connects to /ws. `null` — what a sandboxed iframe sends — fails to parse and is refused with it.
 *
 * Takes trustedRequestOrigins, NOT trustedRequestHosts — see there for why the two differ.
 */
export function validateRequestOrigin(
  origin: string | string[] | undefined,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  const raw = singleHeader(origin);
  if (!raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const hostname = normalizeHostname(parsed.host);
  return hostname !== null && trustedOrigins.has(hostname);
}

/**
 * The primitives checkAuth/isCsrf need off a request — extracted so the core logic never touches
 * Node's http types and can be unit-tested with plain objects. `assertion` is the raw value of the
 * header the configured UI mode reads, empty in every mode that reads none. `hostname` is the
 * already-validated request host, used to refuse the UI credential on the API gateway host.
 * `isUpgrade` tells a mode whether this is the /ws handshake, the one request that may fall back to
 * a cookie — see uiAuth.ts.
 */
export type AuthRequest = {
  method: string;
  pathname: string;
  authorization: string;
  cookie: string;
  assertion: string;
  hostname: string;
  isUpgrade: boolean;
};

// A repeated assertion header is treated as absent. Node joins duplicates into one comma-separated
// value (only set-cookie becomes an array), and a JWS holds no comma — either shape means two senders.
function singleAssertion(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.includes(",")) return "";
  return value;
}

export function authRequestFromIncoming(
  req: IncomingMessage,
  assertionHeader: string | null = null,
  hostname = "",
  isUpgrade = false,
): AuthRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  return {
    method: req.method ?? "GET",
    pathname: url.pathname,
    authorization: req.headers["authorization"] ?? "",
    cookie: req.headers["cookie"] ?? "",
    assertion: assertionHeader ? singleAssertion(req.headers[assertionHeader]) : "",
    hostname,
    isUpgrade,
  };
}

/**
 * Extracts the client IP. This address is written to the audit trail and keys the brute-force
 * lockout, so a forgeable value is both a poisoned record and a lockout an attacker steps around by
 * rotating a header. cf-connecting-ip is the only forwarded name read: x-real-ip and x-forwarded-for
 * are set by nothing in the chain, so a caller picks their own value. Falls back to the socket peer
 * (the Docker gateway in production — useless for attribution, but never a lie).
 *
 * REQUIRES a hop that overwrites cf-connecting-ip on every route it serves. Cloudflare does at its
 * edge, and deploy/caddy/Caddyfile's forwardedHeaders snippet does for the public API host.
 * A deployment fronted by anything else must strip and re-set it there too, or the caller chooses
 * their own rate-limit bucket. A forwarded loopback address is refused outright — no edge sees a real
 * client at one, and the limiter exempts loopback, so honouring it would waive every limit on demand.
 *
 * Distinct from realtime/clientIp.ts, which reads a NextRequest.
 */
export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["cf-connecting-ip"];
  if (typeof forwarded === "string" && forwarded.trim() && !isLoopbackAddress(forwarded.trim())) {
    return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function checkAuth(
  ip: string,
  req: AuthRequest,
  ui: UiAuthenticator,
  tracker: AuthFailureTracker,
  validatePlatformToken: PlatformTokenValidator = () => false,
  apiHost: string | null = null,
): AuthResult {
  if (tracker.isBlocked(ip)) return "blocked";

  // The agent endpoint authenticates via Bearer API key — exempt it from the UI credential.
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
    // tracker is shared with the UI credential, so a misconfigured script polling an unshared route
    // would lock its own operator out of the web interface after five requests.
    if (!isPlatformRouteAllowed(req.method, req.pathname)) return "unauthorized";

    tracker.clear(ip);
    return "platform";
  }

  // The shared UI credential is the browser front door only; on the public API host the exempt and
  // platform paths above are the sole identities. Untracked: all api.* traffic shares one gateway IP.
  if (apiHost && req.hostname === apiHost) return "unauthorized";

  const outcome = ui.verify(req);
  // "absent" is the normal unauthenticated first request, not an attack, so it never counts toward
  // the lockout — only a credential that was offered and rejected does.
  if (outcome === "absent") return "challenge";
  if (outcome === "invalid") {
    tracker.recordFailure(ip);
    return "unauthorized";
  }

  tracker.clear(ip);
  return "ok";
}

/**
 * Auth for the /ws upgrade. The configured mode is tried first, so a failed attempt still feeds the
 * brute-force tracker, then `verifyCookie` runs as a fallback for the credential a browser cannot
 * attach to a handshake.
 *
 * In `basic` mode that fallback is the minted session cookie: Chrome and Firefox reuse cached Basic
 * credentials on a same-origin upgrade but WebKit does not, so the cookie — issued only after Basic
 * succeeded on an earlier request — proves the same thing one hop removed. In `iap` mode server.ts
 * passes a verifier that always fails: the proxy's own header or cookie is already checked above,
 * and no session cookie is ever minted.
 *
 * Neither "platform" nor "exempt" is accepted here: those credentials are HTTP-only.
 */
export function checkWsAuth(
  ip: string,
  req: AuthRequest,
  ui: UiAuthenticator,
  tracker: AuthFailureTracker,
  verifyCookie: (cookieHeader: string) => boolean,
  apiHost: string | null = null,
): AuthResult {
  const result = checkAuth(ip, req, ui, tracker, () => false, apiHost);
  if (result === "ok" || result === "blocked") return result;
  // The session cookie is a basic-mode UI credential too, so it is refused on the API host alongside
  // the password checkAuth already rejected above.
  if (apiHost && req.hostname === apiHost) return result;
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

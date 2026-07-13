// Request authentication and CSRF logic for the custom HTTP server (server.ts).
//
// Kept out of server.ts so the security-critical pieces — timing-safe Basic-Auth comparison,
// failure-based blocking, and the CSRF guard — are unit-testable in isolation rather than welded
// to the process entry point. server.ts is a thin adapter that extracts primitives off the Node
// request and calls these functions.
import type { IncomingMessage } from "http";
import { timingSafeEqual } from "crypto";

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
// The "Live Server" preview reverse-proxies the browser to the workspace container's own server
// (port 8080). It is opened as a top-level tab, so ordinary same-origin navigations/subresources
// carry the user's cached Basic Auth — no separate token. We only special-case CORS preflight:
// an OPTIONS request carries no credentials, so let it through (it is non-mutating and returns
// only CORS policy headers). The proxy route sets a CSP sandbox on its responses, forcing the
// served app to an opaque origin so it can never reach the real app's session.
const PROXY_AUTH_RE = /^\/api\/workspaces\/([^/]+)\/proxy\//;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type AuthResult = "ok" | "challenge" | "unauthorized" | "blocked";
export type AuthCredentials = { user: string; pass: string };

// The primitives checkAuth/isCsrf need off a request — extracted so the core logic never touches
// Node's http types and can be unit-tested with plain objects.
export type AuthRequest = { method: string; pathname: string; authorization: string };

export function authRequestFromIncoming(req: IncomingMessage): AuthRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  return {
    method: req.method ?? "GET",
    pathname: url.pathname,
    authorization: req.headers["authorization"] ?? "",
  };
}

// Extracts the client IP, preferring the x-real-ip header (set by Tailscale Serve) and falling back
// to the socket peer. Distinct from realtime/clientIp.ts, which reads a NextRequest.
export function getClientIp(req: IncomingMessage): string {
  const h = req.headers["x-real-ip"];
  if (typeof h === "string" && h) return h;
  return req.socket.remoteAddress ?? "unknown";
}

export function checkAuth(
  ip: string,
  req: AuthRequest,
  credentials: AuthCredentials,
  tracker: AuthFailureTracker,
): AuthResult {
  if (!credentials.user || !credentials.pass) return "ok";
  if (tracker.isBlocked(ip)) return "blocked";

  // The agent endpoint authenticates via Bearer API key — exempt it from basic auth.
  if (req.method === "POST" && PUBLIC_API_RE.test(req.pathname)) return "ok";

  // Live Server proxy: let the credential-less CORS preflight through (non-mutating, CORS headers
  // only). The actual proxied request still requires the user's Basic Auth like any other route.
  if (req.method === "OPTIONS" && PROXY_AUTH_RE.test(req.pathname)) return "ok";

  const auth = req.authorization;
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

// CSRF guard: the browser attaches cached Basic Auth to cross-origin requests too, so a malicious
// opaque-origin page (e.g. an agent-built app opened via Live Server) could fire BLIND state-
// changing requests at any workspace (it can't read the reply, but the write still executes).
// Browsers always send Sec-Fetch-Site; reject cross-site mutations to /api/. Requests without the
// header (non-browser clients, e.g. the external agent API using Bearer) are allowed. The Live
// Server proxy is intentionally NOT exempt: mutating calls from the opaque-origin previewed app to
// its own backend are treated as cross-site and blocked in v1 — full interactive support requires
// giving each workspace its own origin (per-workspace-origin previews, tracked separately).
export function isCsrf(req: { method: string; pathname: string; secFetchSite: string | undefined }): boolean {
  if (!MUTATING_METHODS.has(req.method)) return false;
  if (!req.pathname.startsWith("/api/")) return false;
  const site = req.secFetchSite;
  if (typeof site !== "string") return false; // non-browser client
  return site !== "same-origin" && site !== "none";
}

// Signed session cookie, used for one thing only: authenticating the /ws handshake in `basic` mode.
// An `iap` deployment never mints one — the proxy's own assertion rides the upgrade.
//
// A browser cannot set an Authorization header on a WebSocket handshake. Chrome and Firefox paper
// over that by reusing the cached Basic credentials for a same-origin upgrade; WebKit does not, so
// on Safari the handshake is unauthenticatable by Basic alone. A cookie is the one credential every
// browser does attach to an upgrade, so server.ts mints this after a request proves it knows the
// Basic credentials, and the upgrade handler accepts it as a fallback.
//
// Scope is deliberately narrow. This cookie is NOT accepted for HTTP requests — Basic stays the sole
// HTTP credential — so it adds no bypass for the API surface and, being SameSite=Strict, no CSRF
// surface either. It carries no identity because there is none to carry: the deployment has a single
// shared username/password, so the only thing worth signing is an expiry.
//
// The key is random per boot and never written to disk. Persisting it would mean writing it under
// WORKSPACES_ROOT, which the credproxy sidecar mounts read-only — the one container reachable from
// an untrusted workspace, and the one whose .env was trimmed precisely to keep admin credentials out
// of it. The cost is that a restart invalidates outstanding cookies; the next authenticated page
// load mints a fresh one, which is why the client hooks fall back to a "reload to reconnect" state
// rather than retrying a handshake that cannot start succeeding on its own.
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { readCookie } from "./cookies";

export const SESSION_COOKIE_NAME = "paodo_ws_session";

const TTL_MS = 12 * 60 * 60 * 1000;
// Re-mint once a cookie is within this long of expiring, so an open tab's socket does not die
// mid-session. Every authenticated HTTP request is a chance to refresh; this keeps that from
// meaning "set the cookie on every asset response".
const REFRESH_BEFORE_MS = 60 * 60 * 1000;

let sessionKey: Buffer | null = null;

function getKey(): Buffer {
  if (!sessionKey) sessionKey = randomBytes(32);
  return sessionKey;
}

function sign(payload: string): string {
  return createHmac("sha256", getKey()).update(payload).digest("hex");
}

export type SessionCookieOptions = { isProduction: boolean };

// Builds the Set-Cookie value. `Secure` is gated on isProduction for the same reason
// securityHeaders.ts gates HSTS: dev runs over plain http and the browser would drop the cookie.
export function mintSessionCookie(opts: SessionCookieOptions): string {
  const exp = String(Date.now() + TTL_MS);
  const attrs = [
    `${SESSION_COOKIE_NAME}=${exp}.${sign(exp)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (opts.isProduction) attrs.push("Secure");
  return attrs.join("; ");
}

// Returns the cookie's expiry timestamp when the signature verifies and the cookie is still valid,
// otherwise null. Every malformed shape — absent header, missing cookie, no separator, non-numeric
// expiry, wrong signature length, bad signature, expired — returns null, so callers fail closed.
export function sessionExpiry(cookieHeader: string | undefined): number | null {
  const raw = readCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (!raw) return null;

  const dot = raw.indexOf(".");
  if (dot === -1) return null;
  const payload = raw.slice(0, dot);
  const presented = raw.slice(dot + 1);

  // Verify before trusting the payload for anything, including the expiry comparison below.
  const expected = Buffer.from(sign(payload), "latin1");
  const got = Buffer.from(presented, "latin1");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  return exp;
}

export function verifySessionCookie(cookieHeader: string | undefined): boolean {
  return sessionExpiry(cookieHeader) !== null;
}

export function sessionCookieNeedsRefresh(cookieHeader: string | undefined): boolean {
  const exp = sessionExpiry(cookieHeader);
  return exp === null || exp - Date.now() < REFRESH_BEFORE_MS;
}

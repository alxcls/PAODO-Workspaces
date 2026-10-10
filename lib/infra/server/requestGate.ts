/**
 * The checkpoint every HTTP request passes before Next.js: host, rate limit, credential, CSRF, in
 * that order. Built from injected dependencies so the order and each rejection can be tested without
 * a listener; server.ts supplies the real ones.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { publicErrorBody, type AppErrorCode } from "../../errors/appError";
import { runWithLogContext, type createLogger } from "../logger";
import { throttleLog } from "../logThrottle";
import {
  authRequestFromIncoming,
  checkAuth,
  getClientIp,
  isCsrf,
  validateRequestHost,
  type AuthFailureTracker,
  type PlatformTokenValidator,
} from "../security/httpAuth";
import type { checkApiRateLimit } from "../security/rateLimit";
import { buildSecurityHeaders } from "../security/securityHeaders";
import type { UiAuthenticator } from "../security/uiAuth";
import { mintSessionCookie, sessionCookieNeedsRefresh } from "../security/wsSession";
import { auditThrottled, type AuditLogger } from "./rejectionAudit";

export interface RequestGateDependencies {
  uiAuth: UiAuthenticator;
  allowedHosts: ReadonlySet<string>;
  apiHost: string | null;
  authFailures: AuthFailureTracker;
  /** The platform credential is instance-wide; platformAccessPolicy.ts decides what it may reach. */
  validatePlatformToken: PlatformTokenValidator;
  checkRateLimit: typeof checkApiRateLimit;
  /** Gates HSTS and the cookie's `Secure` attribute; false over plain http in development. */
  hardenedBrowser: boolean;
  /** Receives every request that passed the gate — the Next.js request handler in production. */
  handle: (req: IncomingMessage, res: ServerResponse) => unknown;
  log: ReturnType<typeof createLogger>;
  audit: AuditLogger;
}

// A mode with no challenge sends no header at all: behind an identity-aware proxy a browser prompt
// cannot satisfy the 401, and naming a scheme would advertise one this deployment does not accept.
function authenticateHeader(scheme: string | null): Record<string, string> {
  return scheme ? { "WWW-Authenticate": scheme } : {};
}

export function createRequestGate(deps: RequestGateDependencies): (req: IncomingMessage, res: ServerResponse) => void {
  const { uiAuth, allowedHosts, apiHost, authFailures, log, audit } = deps;
  const securityHeaders = buildSecurityHeaders({ isProduction: deps.hardenedBrowser });
  let authLoggedOnce = false;

  return (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const pathname = new URL(url, "http://localhost").pathname;
    const requestId = randomUUID();
    const start = process.hrtime.bigint();
    let logged = false;
    // Set by the rejection paths, which emit their own audit line, so a caller hammering an
    // exhausted limit costs one line per request instead of two.
    let audited = false;
    const logRequest = () => {
      if (logged) return;
      logged = true;
      // The rejection's audit record already carries the route, the client address and the reason.
      if (audited) return;
      const durationNs = process.hrtime.bigint() - start;
      const durationMs = Number(durationNs) / 1_000_000;
      // `event` rather than a second `context` field: the child logger already binds context, and
      // two keys of the same name in one JSON object is malformed enough to break some readers.
      const meta = { method, pathname, status: res.statusCode, durationMs, requestId, event: "http_request" };
      if (res.statusCode >= 500)
        log.error({ ...meta, event: "http_request", outcome: "request_failed" }, "http request");
      // 429s from inside Next (the route-level limits in lib/api/guards.ts) are equally
      // caller-driven, so they get the same throttle rather than a line each.
      else if (res.statusCode === 429) {
        const suppressed = throttleLog("http_rate_limited");
        if (suppressed !== null) log.warn({ ...meta, suppressed }, "http request");
      } else if (res.statusCode >= 400) log.warn(meta, "http request");
      // Successes log at info as the "is anything happening" signal that reaches Docker's output.
      // Static assets, upload chunks and task polling stay out: high volume, nothing to observe.
      else if (!url.startsWith("/_next/") && !url.includes("/files/upload") && !url.includes("/background-tasks"))
        log.info(meta, "http request");
    };
    res.once("finish", logRequest);
    res.once("close", logRequest);

    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
    res.setHeader("X-Request-Id", requestId);
    req.headers["x-request-id"] = requestId;

    // Rejections happen before Next.js, so they cannot use the route-level response helper. API
    // callers still get the public envelope; browser pages keep the terse text body.
    const reject = (status: number, code: AppErrorCode, message: string, headers: Record<string, string> = {}) => {
      if (pathname.startsWith("/api/")) {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...headers,
        });
        res.end(JSON.stringify(publicErrorBody(code, message, { requestId })));
        return;
      }
      res.writeHead(status, headers);
      res.end(message);
    };

    // Always names method and pathname: the access line is suppressed for an audited request, so
    // this record is the only place a denied request's route is written down.
    const auditRejection = (event: string, fields: Record<string, unknown>, msg: string) => {
      audited = true;
      auditThrottled(audit, event, { ip, method, pathname, ...fields, requestId }, msg);
    };

    const ip = getClientIp(req);
    const hostValidation = validateRequestHost(req.headers, allowedHosts);
    if (!hostValidation.ok) {
      auditRejection("request_host_rejected", { reason: hostValidation.reason }, "request host rejected");
      reject(421, "INVALID_REQUEST", "Misdirected Request");
      return;
    }
    if (pathname.startsWith("/api/")) {
      const rl = deps.checkRateLimit(ip, method, pathname);
      if (!rl.ok) {
        auditRejection("api_rate_limited", { policy: rl.policy }, "API rate limit exceeded");
        reject(429, "RATE_LIMITED", "Too Many Requests", {
          "Retry-After": String(rl.retryAfter),
          "RateLimit-Limit": String(rl.limit),
          "RateLimit-Remaining": String(rl.remaining),
        });
        return;
      }
    }

    const authResult = checkAuth(
      ip,
      authRequestFromIncoming(req, uiAuth.assertionHeader, hostValidation.hostname),
      uiAuth,
      authFailures,
      deps.validatePlatformToken,
      apiHost,
    );
    if (authResult === "blocked") {
      auditRejection("auth_blocked", {}, "auth blocked");
      reject(429, "RATE_LIMITED", "Too Many Requests", { "Retry-After": "60" });
      return;
    }
    if (authResult === "challenge") {
      audit.debug({ ip, requestId, event: "auth_challenge" }, "auth challenge");
      reject(401, "UNAUTHORIZED", "Unauthorized", authenticateHeader(uiAuth.challenge));
      return;
    }
    if (authResult === "unauthorized") {
      auditRejection("auth_unauthorized", {}, "auth unauthorized");
      const bearer = req.headers["authorization"]?.startsWith("Bearer ");
      // No UI challenge on the public API host: the credential it names is refused there, and
      // advertising it invites the confusion that made the password look like an identity on it.
      const uiChallenge = hostValidation.hostname === apiHost ? null : uiAuth.challenge;
      reject(401, "UNAUTHORIZED", "Unauthorized", authenticateHeader(bearer ? 'Bearer realm="PAODO"' : uiChallenge));
      return;
    }

    // Not gated on an Authorization header: in `iap` mode a verified request carries none, and that
    // is the mode that most needs this one "auth works" line.
    if (authResult === "ok" && !authLoggedOnce) {
      authLoggedOnce = true;
      audit.info({ requestId, event: "auth_ok", authMode: uiAuth.mode }, "auth configured and working");
    }

    // The /ws session cookie is minted only in `basic` mode and only for a verified UI credential.
    // Platform tokens and route-authenticated agent/MCP credentials never become sessions.
    if (uiAuth.mode === "basic" && authResult === "ok" && sessionCookieNeedsRefresh(req.headers["cookie"])) {
      res.setHeader("Set-Cookie", mintSessionCookie({ isProduction: deps.hardenedBrowser }));
    }

    if (isCsrf({ method, pathname, secFetchSite: req.headers["sec-fetch-site"] as string | undefined })) {
      auditRejection("csrf_blocked", {}, "csrf blocked");
      reject(403, "FORBIDDEN", "Forbidden");
      return;
    }

    // Every log produced while Next handles this request (including caught route errors) inherits
    // the access log's correlation fields without each route binding them manually.
    runWithLogContext({ requestId, method, pathname }, () => {
      void deps.handle(req, res);
    });
  };
}

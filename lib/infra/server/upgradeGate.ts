/**
 * The checkpoint for the /ws handshake: host, origin, credential, in that order. Upgrades on any
 * other path are left alone. server.ts supplies the real dependencies; see requestGate.ts.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import {
  authRequestFromIncoming,
  checkWsAuth,
  getClientIp,
  validateRequestHost,
  validateRequestOrigin,
  type AuthFailureTracker,
} from "../security/httpAuth";
import type { UiAuthenticator } from "../security/uiAuth";
import { auditThrottled, type AuditLogger } from "./rejectionAudit";

export interface UpgradeGateDependencies {
  uiAuth: UiAuthenticator;
  allowedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
  apiHost: string | null;
  authFailures: AuthFailureTracker;
  /** Fallback for the credential a browser cannot put on a handshake; always false in `iap` mode. */
  verifySessionCookie: (cookieHeader: string) => boolean;
  /** Completes a handshake that passed the gate — the WebSocketServer's handleUpgrade in production. */
  accept: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  audit: AuditLogger;
}

export function createUpgradeGate(
  deps: UpgradeGateDependencies,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const { uiAuth, allowedHosts, allowedOrigins, apiHost, authFailures, audit } = deps;

  return (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "", "http://localhost");
    if (pathname !== "/ws") return;

    const requestId = randomUUID();
    const ip = getClientIp(req);
    const refuse = (statusLine: string, event: string, msg: string) => {
      auditThrottled(audit, event, { ip, requestId, transport: "websocket" }, msg);
      socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n`);
      socket.destroy();
    };

    const hostValidation = validateRequestHost(req.headers, allowedHosts);
    if (!hostValidation.ok) {
      refuse("421 Misdirected Request", "request_host_rejected", "request host rejected");
      return;
    }
    // Before authentication, because the credential is the problem here: a handshake carries it
    // whoever opened the page, and an accepted socket is readable by that page. See httpAuth.ts.
    if (!validateRequestOrigin(req.headers.origin, allowedOrigins)) {
      refuse("403 Forbidden", "request_origin_rejected", "request origin rejected");
      return;
    }
    const authRequest = authRequestFromIncoming(req, uiAuth.assertionHeader, hostValidation.hostname, true);
    const authResult = checkWsAuth(ip, authRequest, uiAuth, authFailures, deps.verifySessionCookie, apiHost);
    if (authResult === "blocked") {
      refuse("429 Too Many Requests\r\nRetry-After: 60", "auth_blocked", "auth blocked");
      return;
    }
    if (authResult === "challenge" || authResult === "unauthorized") {
      // Deliberately NO WWW-Authenticate: WebKit cannot satisfy a challenge on a handshake, so one
      // opened a credential dialog that the hooks' auto-reconnect re-opened every 2s forever.
      if (authResult === "unauthorized") refuse("401 Unauthorized", "auth_unauthorized", "auth unauthorized");
      else refuse("401 Unauthorized", "auth_challenge", "auth challenge");
      return;
    }
    deps.accept(req, socket, head);
  };
}

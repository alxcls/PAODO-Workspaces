// Custom Node.js entry point that runs Next.js on a manually created HTTP server.
// This is needed to co-host a WebSocket server on the same port: upgrade requests
// to /ws are routed to the app's WebSocket manager, while all other upgrades
// (e.g. Next.js HMR) and plain HTTP requests are forwarded to Next.js as normal.

import "dotenv/config";
import { createServer } from "http";
import { timingSafeEqual } from "crypto";
import { createLogger } from "./lib/infra/logger";

const log = createLogger("server");

import next from "next";
import { WebSocketServer } from "ws";
import { getStore, getContainers, getVersioning } from "./lib/infra/services";
import { setTodos } from "./lib/workspace/todoStore";
import { loadIndex } from "./lib/workspace/conversationStore";
import {
  addConnection,
  removeConnection,
  getConnectionCount,
} from "./lib/infra/realtime/wsHub";
import { ensureWatcher, stopWatcher, markSelfWrite, stopAllWatchers } from "./lib/workspace/workspaceWatcher";
import { validatePreviewToken } from "./lib/infra/security/previewToken";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);

const UI_USER = process.env.USERNAME ?? "";
const UI_PASS = process.env.PASSWORD ?? "";

const AUTH_FAIL_MAX = 5;
const AUTH_FAIL_WINDOW_MS = 60_000;
const authFailures = new Map<string, { count: number; resetAt: number }>();
let authLoggedOnce = false;

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.byteLength !== bBuf.byteLength) {
    // dummy compare to avoid length-based timing oracle
    timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function getClientIp(req: import("http").IncomingMessage): string {
  const h = req.headers["x-real-ip"];
  if (typeof h === "string" && h) return h;
  return req.socket.remoteAddress ?? "unknown";
}

function isAuthBlocked(ip: string): boolean {
  const entry = authFailures.get(ip);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= AUTH_FAIL_MAX;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
  } else {
    entry.count++;
  }
}

function clearAuthFailures(ip: string): void {
  authFailures.delete(ip);
}

function setSecurityHeaders(req: import("http").IncomingMessage, res: import("http").ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  // The HTML-preview iframe runs at an OPAQUE origin (sandboxed, no allow-same-origin) and, being a
  // srcdoc document, INHERITS this page's CSP. Under an opaque origin `'self'` no longer matches our
  // own app origin, so the preview's app-origin subresources (images/styles/fonts/scripts/base href
  // via the serve route) and its token-gated proxy fetch would be blocked. Naming our own origin
  // explicitly alongside `'self'` fixes that — for any normal same-origin document it is equivalent
  // to `'self'`; it only additionally lets opaque-origin previews load OUR-origin resources (display-
  // only or token-gated), never any third-party origin.
  const proto = (((req.headers["x-forwarded-proto"] as string) || "").split(",")[0].trim())
    || (process.env.NODE_ENV === "production" ? "https" : "http");
  const host = req.headers["host"];
  const self = host ? `'self' ${proto}://${host}` : "'self'";
  res.setHeader(
    "Content-Security-Policy",
    [
      `default-src ${self}`,
      `script-src ${self} 'unsafe-inline'${process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""}`,
      `style-src ${self} 'unsafe-inline'`,
      `img-src ${self} data: blob:`,
      `font-src ${self}`,
      `connect-src ${self} ws: wss:`,
      `worker-src ${self} blob: data:`,
      "frame-src 'self'",
      "frame-ancestors 'none'",
      `form-action ${self}`,
      `base-uri ${self}`,
    ].join("; ")
  );
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
}

const PUBLIC_API_RE = /^\/api\/workspaces\/[^/]+\/agent$/;
// The HTML-preview iframe runs at an opaque origin and reaches its OWN workspace's backend via the
// proxy/serve routes, authenticating with a per-workspace preview token instead of the user's Basic
// Auth. Proxy calls are fetch()-driven, so the token rides as a Bearer header (group 1 = the
// workspace id it must match).
const PROXY_AUTH_RE = /^\/api\/workspaces\/([^/]+)\/proxy\//;
// Serve delivers the preview's static subresources (<link>, <script type=module> and its nested
// relative imports), which the browser fetches itself — our fetch shim can't reach them and they
// can't carry a header. So the token rides in the path as the first segment after /serve/, where it
// survives relative-URL resolution. Group 1 = workspace id, group 2 = token.
const SERVE_AUTH_RE = /^\/api\/workspaces\/([^/]+)\/serve\/([^/]+)/;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// CSRF guard: the browser attaches cached Basic Auth to cross-origin requests too, so a malicious
// opaque-origin preview could fire BLIND state-changing requests at other workspaces (it can't
// read the reply, but the write still executes). Browsers always send Sec-Fetch-Site; reject
// cross-site mutations. Requests without the header (non-browser clients, e.g. the external agent
// API using Bearer) are allowed. The preview's own cross-origin calls hit the token-gated
// proxy/serve routes, which are exempt.
function isCsrf(req: import("http").IncomingMessage, pathname: string): boolean {
  if (!MUTATING_METHODS.has(req.method ?? "GET")) return false;
  if (!pathname.startsWith("/api/")) return false;
  if (PROXY_AUTH_RE.test(pathname)) return false; // token-gated; serve is GET-only so never mutating
  const site = req.headers["sec-fetch-site"];
  if (typeof site !== "string") return false; // non-browser client
  return site !== "same-origin" && site !== "none";
}

function checkAuth(ip: string, req: import("http").IncomingMessage): "ok" | "challenge" | "unauthorized" | "blocked" {
  if (!UI_USER || !UI_PASS) return "ok";
  if (isAuthBlocked(ip)) return "blocked";

  // The agent endpoint authenticates via Bearer API key — exempt it from basic auth.
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && PUBLIC_API_RE.test(url.pathname)) return "ok";

  // Preview routes accept a valid per-workspace preview token as a Basic-Auth bypass for that
  // workspace only. A token for workspace A presented on workspace B's URL fails the match.
  // Proxy: token as a Bearer header; let the CORS preflight (no credentials, headers only) through.
  const proxy = PROXY_AUTH_RE.exec(url.pathname);
  if (proxy) {
    if (req.method === "OPTIONS") return "ok";
    const bearer = /^Bearer (.+)$/.exec(req.headers["authorization"] ?? "");
    if (bearer && validatePreviewToken(proxy[1], bearer[1])) return "ok";
  }
  // Serve: token is the first path segment. It's hex, so encodeURIComponent is identity and no
  // decode is needed (avoids a throw on a malformed %-sequence in a hostile path).
  const serve = SERVE_AUTH_RE.exec(url.pathname);
  if (serve && validatePreviewToken(serve[1], serve[2])) return "ok";

  const auth = req.headers["authorization"] ?? "";
  if (!auth.startsWith("Basic ")) {
    // No credentials sent — normal browser challenge-response handshake, not an attack
    return "challenge";
  }

  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  if (colon === -1) {
    recordAuthFailure(ip);
    return "unauthorized";
  }

  const userOk = safeEqual(decoded.slice(0, colon), UI_USER);
  const passOk = safeEqual(decoded.slice(colon + 1), UI_PASS);

  if (userOk && passOk) {
    clearAuthFailures(ip);
    return "ok";
  }

  recordAuthFailure(ip);
  return "unauthorized";
}

const httpServer = createServer();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app = next({ dev, httpServer, port, webpack: true } as any);
const handle = app.getRequestHandler();

httpServer.on("request", (req, res) => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const start = process.hrtime.bigint();
  let logged = false;
  const logRequest = () => {
    if (logged) return;
    logged = true;
    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs) / 1_000_000;
    const meta = { method, url, status: res.statusCode, durationMs, context: "http" };
    if (res.statusCode >= 500) log.error(meta, "http request");
    else if (res.statusCode >= 400) log.warn(meta, "http request");
    else if (!url.startsWith("/_next/") && !url.includes("/files/upload")) log.debug(meta, "http request");
  };
  res.once("finish", logRequest);
  res.once("close", logRequest);

  setSecurityHeaders(req, res);

  const ip = getClientIp(req);
  const authResult = checkAuth(ip, req);
  if (authResult === "blocked") {
    log.warn({ ip, event: "auth_blocked" }, "auth blocked");
    res.writeHead(429, { "Retry-After": "60" });
    res.end("Too Many Requests");
    return;
  }
  if (authResult === "challenge") {
    log.debug({ ip, event: "auth_challenge" }, "auth challenge");
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="App"' });
    res.end("Unauthorized");
    return;
  }
  if (authResult === "unauthorized") {
    log.warn({ ip, event: "auth_unauthorized" }, "auth unauthorized");
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="App"' });
    res.end("Unauthorized");
    return;
  }

  if (req.headers["authorization"] && !authLoggedOnce) {
    authLoggedOnce = true;
    log.info({ event: "auth_ok" }, "auth configured and working");
  }

  const pathname = new URL(url, "http://localhost").pathname;
  if (isCsrf(req, pathname)) {
    log.warn({ ip, method, url, event: "csrf_blocked" }, "csrf blocked");
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  handle(req, res);
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "", "http://localhost");
  if (pathname === "/ws") {
    const wsIp = getClientIp(req);
    const wsAuthResult = checkAuth(wsIp, req);
    if (wsAuthResult === "blocked") {
      log.warn({ ip: wsIp, event: "auth_blocked" }, "auth blocked");
      socket.write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n");
      socket.destroy();
      return;
    }
    if (wsAuthResult === "challenge" || wsAuthResult === "unauthorized") {
      if (wsAuthResult === "unauthorized") log.warn({ ip: wsIp, event: "auth_unauthorized" }, "auth unauthorized");
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"App\"\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});

wss.on("connection", (ws, req) => {
  const workspaceId = new URL(req.url ?? "", "http://localhost").searchParams.get("workspaceId") ?? undefined;

  if (!workspaceId) {
    ws.close(1008, "workspaceId query param required");
    return;
  }

  const workspace = getStore().getWorkspace(workspaceId);
  if (!workspace) {
    ws.close(1008, "workspace not found");
    return;
  }

  const wasEmpty = getConnectionCount(workspaceId) === 0;
  addConnection(workspaceId, ws);
  if (wasEmpty) {
    // First connection — load saved conversations from disk so a returning user immediately sees
    // their history. Conversations persist across restarts and disconnects (and a run keeps going
    // even with no one connected), so we deliberately no longer wipe message history here.
    try {
      loadIndex(workspaceId);
    } catch (err) {
      log.error({ workspaceId, err }, "failed to load conversations");
    }
    ensureWatcher(workspaceId, workspace.dir);
  }

  const cleanup = () => {
    removeConnection(workspaceId, ws);
    setTimeout(() => {
      if (getConnectionCount(workspaceId) === 0) {
        stopWatcher(workspaceId);
        setTodos(workspaceId, []);
      }
    }, 5000);
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString()) as { type: string; path?: string };
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
      if (msg.type === "self_write" && msg.path) {
        markSelfWrite(msg.path);
      }
    } catch {
      // ignore malformed messages
    }
  });
});

if ((!UI_USER || !UI_PASS) && !dev) {
  log.error("USERNAME and PASSWORD must be set in production — refusing to start.");
  process.exit(1);
}

// Snapshots (workspace version history) shell out to the `git` binary, and those failures are
// swallowed at runtime so a run never breaks. That makes a missing git invisible — which is exactly
// how it silently disabled history in the production image once. Probe at boot: refuse to start in
// production (like the Docker/credentials guards), warn in dev where snapshots are non-critical.
async function assertGitAvailable() {
  if (await getVersioning().isGitAvailable()) return;
  if (!dev) {
    log.error("git is not available — workspace version history (snapshots) would silently no-op. Refusing to start.");
    process.exit(1);
  }
  log.warn("git is not available — workspace snapshots will be disabled until git is installed.");
}

assertGitAvailable()
  .then(() => getContainers().assertDockerAvailable())
  .then(() => app.prepare())
  .then(() => {
    httpServer.listen(port, () => {
      log.info(`Ready on http://localhost:${port}`);
    });
  });

function shutdown() {
  wss.close();
  stopAllWatchers();
  app.close().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

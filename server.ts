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
import { assertDockerAvailable, ensureContainer } from "./lib/infra/containerManager";
import { WebSocketServer } from "ws";
import { getWorkspace, resetWorkspaceMessages } from "./lib/infra/workspaceStore";
import { setTodos } from "./lib/infra/todoStore";
import {
  addConnection,
  removeConnection,
  getConnectionCount,
} from "./lib/infra/wsHub";
import { ensureWatcher, stopWatcher, markSelfWrite, stopAllWatchers } from "./lib/infra/workspaceWatcher";

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

function setSecurityHeaders(res: import("http").ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self' ws: wss:",
      "worker-src 'self' blob: data:",
      "frame-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
    ].join("; ")
  );
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
}

const PUBLIC_API_RE = /^\/api\/workspaces\/[^/]+\/agent$/;

function checkAuth(ip: string, req: import("http").IncomingMessage): "ok" | "challenge" | "unauthorized" | "blocked" {
  if (!UI_USER || !UI_PASS) return "ok";
  if (isAuthBlocked(ip)) return "blocked";

  // The agent endpoint authenticates via Bearer API key — exempt it from basic auth.
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && PUBLIC_API_RE.test(url.pathname)) return "ok";

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

  setSecurityHeaders(res);

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

  const workspace = getWorkspace(workspaceId);
  if (!workspace) {
    ws.close(1008, "workspace not found");
    return;
  }

  const wasEmpty = getConnectionCount(workspaceId) === 0;
  addConnection(workspaceId, ws);
  if (wasEmpty) {
    // First connection — treat as a new session: clear conversation history and todos
    // so prior agent state (including todo_write calls) never bleeds into the new session.
    resetWorkspaceMessages(workspaceId).catch((err) =>
      log.error({ workspaceId, err }, "failed to reset messages")
    );
    setTodos(workspaceId, []);
    ensureWatcher(workspaceId, workspace.dir);
  }

  const cleanup = () => {
    removeConnection(workspaceId, ws);
    setTimeout(() => {
      if (getConnectionCount(workspaceId) === 0) {
        stopWatcher(workspaceId);
        resetWorkspaceMessages(workspaceId).catch((err) =>
          log.error({ workspaceId, err }, "failed to reset messages on disconnect")
        );
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

assertDockerAvailable().then(() => app.prepare()).then(() => {
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

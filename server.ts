// Custom Node.js entry point that runs Next.js on a manually created HTTP server.
// This is needed to co-host a WebSocket server on the same port: upgrade requests
// to /ws are routed to the app's WebSocket manager, while all other upgrades
// (e.g. Next.js HMR) and plain HTTP requests are forwarded to Next.js as normal.

import "dotenv/config";
import { createServer } from "http";
import { createLogger } from "./lib/infra/logger";

const log = createLogger("server");

import next from "next";
import { WebSocketServer } from "ws";
import { getStore, getContainers, getVersioning, getCredentialProxy } from "./lib/infra/services";
import { ensureCA } from "./lib/infra/proxy/proxyCA";
import { WORKSPACES_ROOT } from "./lib/infra/paths";
import { getWorkspaceRules } from "./lib/infra/security/workspaceSecretStore";
import { setTodos } from "./lib/workspace/todoStore";
import { loadIndex } from "./lib/workspace/conversationStore";
import { addConnection, removeConnection, getConnectionCount } from "./lib/infra/realtime/wsHub";
import { ensureWatcher, stopWatcher, markSelfWrite, stopAllWatchers } from "./lib/workspace/workspaceWatcher";
import {
  AuthFailureTracker,
  authRequestFromIncoming,
  checkAuth,
  getClientIp,
  isCsrf,
  type AuthResult,
} from "./lib/infra/security/httpAuth";
import { buildSecurityHeaders } from "./lib/infra/security/securityHeaders";
import { startScheduler, stopScheduler } from "./lib/infra/schedules/scheduler";
import { startProxyReconciler, stopProxyReconciler } from "./lib/infra/docker/proxyReconciler";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);

const UI_USER = process.env.USERNAME ?? "";
const UI_PASS = process.env.PASSWORD ?? "";
const credentials = { user: UI_USER, pass: UI_PASS };

const authFailures = new AuthFailureTracker();
let authLoggedOnce = false;

// Thin adapter: extract the request primitives and delegate to the testable checkAuth.
function authenticate(ip: string, req: import("http").IncomingMessage): AuthResult {
  return checkAuth(ip, authRequestFromIncoming(req), credentials, authFailures);
}

function setSecurityHeaders(res: import("http").ServerResponse): void {
  const headers = buildSecurityHeaders({
    isProduction: process.env.NODE_ENV === "production",
  });
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
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
  const authResult = authenticate(ip, req);
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
  if (isCsrf({ method, pathname, secFetchSite: req.headers["sec-fetch-site"] as string | undefined })) {
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
    const wsAuthResult = authenticate(wsIp, req);
    if (wsAuthResult === "blocked") {
      log.warn({ ip: wsIp, event: "auth_blocked" }, "auth blocked");
      socket.write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n");
      socket.destroy();
      return;
    }
    if (wsAuthResult === "challenge" || wsAuthResult === "unauthorized") {
      if (wsAuthResult === "unauthorized") log.warn({ ip: wsIp, event: "auth_unauthorized" }, "auth unauthorized");
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="App"\r\n\r\n');
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

const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT ?? "9998", 10);

assertGitAvailable()
  .then(() => getContainers().assertDockerAvailable())
  .then(async () => {
    // The app owns CA generation (writable data mount); the credproxy sidecar only loads it.
    ensureCA(WORKSPACES_ROOT);
    if (!process.env.WORKSPACES_VOLUME_NAME) {
      // Local dev: the app runs on the host, so it hosts the proxy in-process at
      // host.docker.internal:9998. Reload persisted rules (lost on restart).
      const proxy = getCredentialProxy();
      proxy.listen(CREDENTIAL_PROXY_PORT);
      for (const ws of getStore().listWorkspaces()) {
        proxy.setRules(ws.id, getWorkspaceRules(ws.id));
      }
    } else {
      // Production: the proxy runs in the `credproxy` sidecar (so the app never joins a workspace
      // network). A redeploy recreates the sidecar and drops its attachments — reconnect running
      // workspaces so their egress keeps working.
      await getContainers().reattachProxyNetworks();
      // Boot-time reattach only heals sidecar recreations that coincide with an app restart. Keep a
      // reconcile loop running so an independent sidecar restart self-heals within one interval.
      startProxyReconciler();
    }
  })
  .then(() => app.prepare())
  .then(() => {
    httpServer.listen(port, () => {
      log.info(`Ready on http://localhost:${port}`);
    });
    // Fire workspace schedules on their recurrence (in-process tick loop). Started after boot so
    // the store/services are ready; missed slots from any downtime are skipped, not replayed.
    startScheduler();
  });

function shutdown() {
  wss.close();
  stopScheduler();
  stopProxyReconciler();
  stopAllWatchers();
  app.close().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

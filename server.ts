// Custom Node.js entry point that runs Next.js on a manually created HTTP server.
// This is needed to co-host a WebSocket server on the same port: upgrade requests
// to /ws are routed to the app's WebSocket manager, while all other upgrades
// (e.g. Next.js HMR) and plain HTTP requests are forwarded to Next.js as normal.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer } from "http";
import path from "path";
import { createAuditLogger, createLogger, exitAfterLogs, runWithLogContext } from "./lib/infra/logger";
import { throttleLog } from "./lib/infra/logThrottle";

const log = createLogger("server");
const audit = createAuditLogger("server");

function fatal(reason: string, err: unknown): never {
  log.fatal({ event: "process_fatal", outcome: "process_exit", err, reason }, "process exiting after fatal error");
  exitAfterLogs(1);
}

process.on("uncaughtException", (err) => fatal("uncaughtException", err));
process.on("unhandledRejection", (err) => fatal("unhandledRejection", err));

import next from "next";
import { WebSocketServer } from "ws";
import { getStore, getContainers, getVersioning, getCredentialProxy } from "./lib/infra/services";
import { ensureCA } from "./lib/infra/proxy/proxyCA";
import { WORKSPACES_ROOT } from "./lib/infra/paths";
import { assertSecretStoreAvailable, getWorkspaceRules } from "./lib/infra/security/workspaceSecretStore";
import { setTodos } from "./lib/workspace/todoStore";
import { loadIndex } from "./lib/workspace/conversationStore";
import { addConnection, removeConnection, getConnectionCount } from "./lib/infra/realtime/wsHub";
import { ensureWatcher, stopWatcher, markSelfWrite, stopAllWatchers } from "./lib/workspace/workspaceWatcher";
import {
  AuthFailureTracker,
  authRequestFromIncoming,
  checkAuth,
  checkWsAuth,
  getClientIp,
  isCsrf,
  type AuthResult,
} from "./lib/infra/security/httpAuth";
import { mintSessionCookie, sessionCookieNeedsRefresh, verifySessionCookie } from "./lib/infra/security/wsSession";
import { buildSecurityHeaders } from "./lib/infra/security/securityHeaders";
import { startScheduler, stopScheduler } from "./lib/infra/schedules/scheduler";
import { startProxyReconciler, stopProxyReconciler } from "./lib/infra/docker/proxyReconciler";
import { startUploadSweeper, stopUploadSweeper } from "./lib/workspace/uploadSweeper";
import { checkApiRateLimit } from "./lib/infra/security/rateLimit";
import { hasConfiguredProviderApiKey } from "./lib/agent/buildModel";
import { assertDataRootAvailable, assertWorkspaceRegistryAvailable } from "./lib/infra/startupChecks";
import { appDataDb, PAODO_DB_FILE } from "./lib/data/database";

const dev = process.env.NODE_ENV !== "production";
const rawPort = process.env.PORT ?? "3000";
const port = Number(rawPort);

const UI_USER = process.env.USERNAME ?? "";
const UI_PASS = process.env.PASSWORD ?? "";
const credentials = { user: UI_USER, pass: UI_PASS };

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  log.fatal(
    {
      event: "startup_http_listener_failed",
      outcome: "process_exit",
      err: new Error(`PORT must be an integer between 1 and 65535; received ${JSON.stringify(rawPort)}`),
      configuredPort: rawPort,
    },
    "HTTP listener configuration is invalid — refusing to start",
  );
  exitAfterLogs(1);
}

const authFailures = new AuthFailureTracker();
let authLoggedOnce = false;

// Thin adapter: extract the request primitives and delegate to the testable checkAuth.
function authenticate(ip: string, req: import("http").IncomingMessage): AuthResult {
  return checkAuth(ip, authRequestFromIncoming(req), credentials, authFailures);
}

// Same adapter for the /ws upgrade, which additionally accepts the session cookie because no browser
// can put Basic credentials on a handshake and WebKit does not reuse the cached ones.
function authenticateWs(ip: string, req: import("http").IncomingMessage): AuthResult {
  return checkWsAuth(ip, authRequestFromIncoming(req), credentials, authFailures, verifySessionCookie);
}

function setSecurityHeaders(res: import("http").ServerResponse): void {
  const headers = buildSecurityHeaders({
    isProduction: process.env.NODE_ENV === "production",
  });
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
}

const httpServer = createServer();
// Node's 5-minute default would abort a legitimate upload of a file near MAX_UPLOAD_BYTES on a slow
// link (a repo's .git pack file is routinely hundreds of MB), and the client would see a dropped
// connection rather than a reason. headersTimeout is deliberately left at its default — headers
// always arrive promptly, so it keeps covering slowloris while this only relaxes the body deadline.
httpServer.requestTimeout = 30 * 60_000;
httpServer.on("error", (err) => {
  log.fatal(
    { event: "startup_http_listener_failed", outcome: "process_exit", err, port },
    "HTTP listener failed — refusing to continue",
  );
  exitAfterLogs(1);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app = next({ dev, httpServer, port, webpack: true } as any);
const handle = app.getRequestHandler();

httpServer.on("request", (req, res) => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const pathname = new URL(url, "http://localhost").pathname;
  const requestId = randomUUID();
  const start = process.hrtime.bigint();
  let logged = false;
  // Set by the rejection paths below, which emit their own audit line. Without this a caller that
  // keeps hammering an exhausted limit costs two lines per request instead of one.
  let audited = false;
  const logRequest = () => {
    if (logged) return;
    logged = true;
    // The audit record for a rejection carries everything this line would, plus the client address
    // and the reason, and it is already throttled. Emitting both just doubles the flood.
    if (audited) return;
    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs) / 1_000_000;
    // `event` rather than a second `context` field: the child logger already binds context, and two
    // keys of the same name in one JSON object is malformed enough to break some readers.
    const meta = { method, pathname, status: res.statusCode, durationMs, requestId, event: "http_request" };
    if (res.statusCode >= 500) log.error({ ...meta, event: "http_request", outcome: "request_failed" }, "http request");
    // 429s from inside Next (the route-level limits in lib/api/guards.ts) are equally caller-driven,
    // so they get the same throttle rather than a line each.
    else if (res.statusCode === 429) {
      const suppressed = throttleLog("http_rate_limited");
      if (suppressed !== null) log.warn({ ...meta, suppressed }, "http request");
    } else if (res.statusCode >= 400) log.warn(meta, "http request");
    // Successful requests are the baseline "is anything happening" signal, so they log at info and
    // reach Docker's output in production; at debug they were invisible there and nothing but errors
    // ever showed up. Static assets and upload chunks stay out — high volume, nothing to observe.
    else if (!url.startsWith("/_next/") && !url.includes("/files/upload")) log.info(meta, "http request");
  };
  res.once("finish", logRequest);
  res.once("close", logRequest);

  setSecurityHeaders(res);
  res.setHeader("X-Request-Id", requestId);
  req.headers["x-request-id"] = requestId;

  // Rejection paths are reachable pre-auth, so an unauthenticated caller drives how often they log.
  // Throttle them and mark the request audited, so one rejected request costs at most one line.
  const auditRejection = (event: string, fields: Record<string, unknown>, msg: string) => {
    audited = true;
    const suppressed = throttleLog(event);
    if (suppressed !== null) audit.warn({ ...fields, event, suppressed }, msg);
  };

  const ip = getClientIp(req);
  if (pathname.startsWith("/api/")) {
    const rl = checkApiRateLimit(ip, method, pathname);
    if (!rl.ok) {
      auditRejection(
        "api_rate_limited",
        { ip, method, pathname, policy: rl.policy, requestId },
        "API rate limit exceeded",
      );
      res.writeHead(429, {
        "Retry-After": String(rl.retryAfter),
        "RateLimit-Limit": String(rl.limit),
        "RateLimit-Remaining": String(rl.remaining),
      });
      res.end("Too Many Requests");
      return;
    }
  }

  const authResult = authenticate(ip, req);
  if (authResult === "blocked") {
    auditRejection("auth_blocked", { ip, requestId }, "auth blocked");
    res.writeHead(429, { "Retry-After": "60" });
    res.end("Too Many Requests");
    return;
  }
  if (authResult === "challenge") {
    audit.debug({ ip, requestId, event: "auth_challenge" }, "auth challenge");
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="App"' });
    res.end("Unauthorized");
    return;
  }
  if (authResult === "unauthorized") {
    auditRejection("auth_unauthorized", { ip, requestId }, "auth unauthorized");
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="App"' });
    res.end("Unauthorized");
    return;
  }

  if (req.headers["authorization"] && !authLoggedOnce) {
    authLoggedOnce = true;
    audit.info({ requestId, event: "auth_ok" }, "auth configured and working");
  }

  // Mint the /ws session cookie — only on "ok", never on "exempt". The exempt routes are the two
  // Bearer-authenticated endpoints that deploy/Caddyfile.workspace-api publishes on the DNS-direct
  // public host, and checkAuth passes them without inspecting any credential. Minting there would
  // hand a working UI session to anyone who can reach that hostname.
  if (authResult === "ok" && sessionCookieNeedsRefresh(req.headers["cookie"])) {
    res.setHeader("Set-Cookie", mintSessionCookie({ isProduction: process.env.NODE_ENV === "production" }));
  }

  if (isCsrf({ method, pathname, secFetchSite: req.headers["sec-fetch-site"] as string | undefined })) {
    auditRejection("csrf_blocked", { ip, method, pathname, requestId }, "csrf blocked");
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  // Every log produced while Next handles this request (including caught route errors) inherits
  // the same correlation fields as the access log without each route having to bind them manually.
  runWithLogContext({ requestId, method, pathname }, () => {
    void handle(req, res);
  });
});

const wss = new WebSocketServer({ noServer: true });
wss.on("error", (err) =>
  log.error({ event: "websocket_server_error", outcome: "websocket_service_degraded", err }, "websocket server error"),
);

httpServer.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "", "http://localhost");
  if (pathname === "/ws") {
    const requestId = randomUUID();
    const wsIp = getClientIp(req);
    const wsAuthResult = authenticateWs(wsIp, req);
    // Same throttle as the HTTP rejections, and the same reason: an upgrade is just as cheap to
    // repeat. The window is shared with the HTTP path — one flood, one line, whichever door it uses.
    const auditWsRejection = (event: string, msg: string) => {
      const suppressed = throttleLog(event);
      if (suppressed !== null) {
        audit.warn({ ip: wsIp, requestId, transport: "websocket", event, suppressed }, msg);
      }
    };
    if (wsAuthResult === "blocked") {
      auditWsRejection("auth_blocked", "auth blocked");
      socket.write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n");
      socket.destroy();
      return;
    }
    if (wsAuthResult === "challenge" || wsAuthResult === "unauthorized") {
      // Both cases audit. A rejected upgrade used to be logged only when credentials were malformed,
      // so the common failure — no credential at all, which is every Safari handshake before the
      // session cookie existed — left no server-side trace at all.
      auditWsRejection(
        wsAuthResult === "unauthorized" ? "auth_unauthorized" : "auth_challenge",
        wsAuthResult === "unauthorized" ? "auth unauthorized" : "auth challenge",
      );
      // Deliberately NO WWW-Authenticate here, unlike the HTTP rejections above. A browser cannot
      // attach an Authorization header to a WebSocket handshake, and WebKit — unlike Chrome and
      // Firefox — does not reuse the cached Basic credentials for it either. Sending a challenge
      // therefore made Safari open a credential dialog the handshake could never satisfy, and the
      // hooks' auto-reconnect re-opened it every 2s forever. Failing without a challenge keeps the
      // socket closed but leaves the browser nothing to prompt on.
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
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
    // First connection — load saved conversations from SQLite so a returning user immediately sees
    // their history. Conversations persist across restarts and disconnects (and a run keeps going
    // even with no one connected), so we deliberately no longer wipe message history here.
    // loadIndex owns its recoverable persistence error log and falls back to an empty index.
    loadIndex(workspaceId);
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
    let msg: { type: string; path?: string };
    try {
      msg = JSON.parse(data.toString()) as { type: string; path?: string };
    } catch {
      // ignore malformed messages
      return;
    }
    try {
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      if (msg.type === "self_write" && msg.path) markSelfWrite(msg.path);
    } catch (err) {
      log.warn({ err, workspaceId, messageType: msg.type }, "websocket message handling failed");
    }
  });
});

// Unconditional by design. Gating this on NODE_ENV once meant a container flipped to debug logging
// served every route unauthenticated.
if (!UI_USER || !UI_PASS) {
  log.fatal(
    { event: "startup_credentials_missing", outcome: "process_exit" },
    "USERNAME and PASSWORD must be set — refusing to start. Copy .env.example to .env and set both.",
  );
  exitAfterLogs(1);
}

if (!hasConfiguredProviderApiKey() && !dev) {
  log.fatal(
    { event: "startup_llm_api_keys_missing", outcome: "process_exit" },
    "At least one LLM provider API key must be set in production — refusing to start.",
  );
  exitAfterLogs(1);
}

try {
  assertDataRootAvailable(WORKSPACES_ROOT);
} catch (err) {
  log.fatal(
    { event: "startup_data_root_unavailable", outcome: "process_exit", err, dataRoot: WORKSPACES_ROOT },
    "workspace data root is unavailable or not writable — refusing to start",
  );
  exitAfterLogs(1);
}

if (!dev) {
  try {
    assertWorkspaceRegistryAvailable(WORKSPACES_ROOT);
  } catch (err) {
    log.fatal(
      {
        event: "startup_workspace_registry_unavailable",
        outcome: "process_exit",
        err,
        filePath: path.join(WORKSPACES_ROOT, ".workspaces.json"),
      },
      "existing workspace registry could not be read safely — refusing to start",
    );
    exitAfterLogs(1);
  }
  try {
    assertSecretStoreAvailable();
  } catch (err) {
    log.fatal(
      {
        event: "startup_secret_store_unavailable",
        outcome: "process_exit",
        err,
        filePath: path.join(WORKSPACES_ROOT, ".workspace-secrets.json"),
      },
      "existing workspace secret store could not be read or decrypted — refusing to start",
    );
    exitAfterLogs(1);
  }
}

try {
  // Opening the application database applies every pending migration before any request, WebSocket,
  // or scheduler can reach a feature store. An incompatible schema is a startup failure, never a
  // partially working application.
  appDataDb();
} catch (err) {
  log.fatal(
    {
      event: "startup_database_unavailable",
      outcome: "process_exit",
      err,
      filePath: PAODO_DB_FILE,
    },
    "application database could not be opened or migrated — refusing to start",
  );
  exitAfterLogs(1);
}

// Snapshots (workspace version history) shell out to the `git` binary, and those failures are
// swallowed at runtime so a run never breaks. That makes a missing git invisible — which is exactly
// how it silently disabled history in the production image once. Probe at boot: refuse to start in
// production (like the Docker guard), warn in dev where snapshots are non-critical. Unlike the
// credentials guard above, staying gated on NODE_ENV is fine — missing history is a degraded feature,
// not an open door.
async function assertGitAvailable() {
  if (await getVersioning().isGitAvailable()) return;
  if (!dev) {
    log.fatal(
      { event: "startup_git_unavailable", outcome: "process_exit" },
      "git is not available — workspace version history (snapshots) would silently no-op. Refusing to start.",
    );
    exitAfterLogs(1);
  }
  log.warn("git is not available — workspace snapshots will be disabled until git is installed.");
}

const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT ?? "9998", 10);

assertGitAvailable()
  .then(() => getContainers().assertDockerAvailable())
  .then(async () => {
    // The app owns CA generation (writable data mount); the credproxy sidecar only loads it.
    try {
      ensureCA(WORKSPACES_ROOT, { strictExisting: !dev });
    } catch (err) {
      log.fatal(
        { event: "startup_proxy_key_material_invalid", outcome: "process_exit", err },
        "existing credential-proxy key material is incomplete or invalid — refusing to start",
      );
      exitAfterLogs(1);
    }
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
      log.info({ event: "server_ready", outcome: "startup_complete", port }, `Ready on http://localhost:${port}`);
    });
    // Fire workspace schedules on their recurrence (in-process tick loop). Started after boot so
    // the store/services are ready; missed slots from any downtime are skipped, not replayed.
    startScheduler();
    // Reclaim upload temp files orphaned by a process kill mid-upload.
    startUploadSweeper();
  })
  .catch((err) => fatal("startup", err));

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  const startedAt = Date.now();
  log.info(
    {
      event: "process_shutdown_started",
      outcome: "shutdown_in_progress",
      signal,
      uptimeMs: Math.round(process.uptime() * 1000),
    },
    "process shutdown started",
  );
  const failShutdown = (err: unknown): never => {
    log.fatal(
      {
        event: "process_shutdown_failed",
        outcome: "process_exit",
        err,
        signal,
        durationMs: Date.now() - startedAt,
      },
      "process shutdown failed",
    );
    exitAfterLogs(1);
  };
  try {
    wss.close();
    stopScheduler();
    stopProxyReconciler();
    stopUploadSweeper();
    stopAllWatchers();
  } catch (err) {
    failShutdown(err);
  }
  app
    .close()
    .then(() => {
      log.info(
        {
          event: "process_shutdown_completed",
          outcome: "process_exit",
          signal,
          durationMs: Date.now() - startedAt,
        },
        "process shutdown completed",
      );
      exitAfterLogs(0);
    })
    .catch(failShutdown);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

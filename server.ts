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
import { publicErrorBody, type AppErrorCode } from "./lib/errors/appError";

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
import { getStore, getContainers, getVersioning } from "./lib/infra/services";
import { ensureCA } from "./lib/infra/proxy/proxyCA";
import { reconcileInternetAccessPolicy } from "./lib/infra/proxy/internetAccessPolicy";
import { WORKSPACES_ROOT, workspaceRegistryFile } from "./lib/infra/paths";
import { getSecretsEncKey } from "./lib/infra/security/secretsEncryption";
import { getProviderVaultKey } from "./lib/infra/security/providerKeyEncryption";
import { assertProviderVaultAvailable, PROVIDER_VAULT_FILE } from "./lib/infra/security/providerKeyVault";
import {
  assertWorkspaceSecretVaultAvailable,
  WORKSPACE_SECRET_VAULT_FILE,
} from "./lib/infra/security/workspaceSecretVault";
import {
  PROVIDER_VAULT_KEY_FILE,
  PROVIDER_VAULT_ROOT,
  WORKSPACE_SECRET_VAULT_KEY_FILE,
  WORKSPACE_SECRET_VAULT_ROOT,
  assertSecretStorageSeparated,
} from "./lib/infra/security/secretVaultPaths";
import { setTodos } from "./lib/todos/store";
import { loadIndex } from "./lib/conversations/store";
import { addConnection, removeConnection, getConnectionCount } from "./lib/infra/realtime/wsHub";
import { ensureWatcher, stopWatcher, markSelfWrite, stopAllWatchers } from "./lib/infra/workspace/watcher";
import {
  AuthFailureTracker,
  authRequestFromIncoming,
  checkAuth,
  checkWsAuth,
  getClientIp,
  isCsrf,
  trustedRequestHosts,
  trustedRequestOrigins,
  apiRequestHost,
  type AuthResult,
  validateRequestHost,
  validateRequestOrigin,
} from "./lib/infra/security/httpAuth";
import { mintSessionCookie, sessionCookieNeedsRefresh, verifySessionCookie } from "./lib/infra/security/wsSession";
import { resolveUiAuth } from "./lib/infra/security/uiAuth";
import { buildSecurityHeaders } from "./lib/infra/security/securityHeaders";
import { startScheduler, stopScheduler } from "./lib/infra/schedules/scheduler";
import { startProxyReconciler, stopProxyReconciler } from "./lib/infra/docker/proxyReconciler";
import { startUploadSweeper, stopUploadSweeper } from "./lib/uploads/sweeper";
import { startPriceRefresher, stopPriceRefresher } from "./lib/models/priceRefresher";
import { checkApiRateLimit } from "./lib/infra/security/rateLimit";
import { availableProviders } from "./lib/agent/buildModel";
import { purgeProviderKeysExcept } from "./lib/infra/security/providerKeyStore";
import {
  assertDataRootAvailable,
  assertWorkspaceRegistryAvailable,
  assertWorkspacesVolumeConfigured,
} from "./lib/infra/startupChecks";
import { appDataDb, PAODO_DB_FILE } from "./lib/data/database";
import { validate as validateCredential } from "./lib/infra/security/credentialStore";
import { capacityProfile } from "./lib/infra/capacityProfile";
import { runtimeMode } from "./lib/infra/runtimeMode";
import { executionCapacity } from "./lib/agent/executionCapacity";

const rawPort = process.env.PORT ?? "3000";
const port = Number(rawPort);

/**
 * How this deployment identifies a browser: a shared password, or an identity-aware proxy whose
 * signed assertion the origin verifies. The two are mutually exclusive — see uiAuth.ts — and an
 * unconfigured mode throws here so the process never serves a route it cannot guard.
 */
let uiAuth: import("./lib/infra/security/uiAuth").UiAuthenticator;
try {
  uiAuth = resolveUiAuth();
} catch (err) {
  log.fatal(
    { event: "startup_credentials_missing", outcome: "process_exit", err },
    "UI authentication is not configured — refusing to start. See .env.example.",
  );
  exitAfterLogs(1);
}

// In `iap` mode there is no session cookie to fall back to: the proxy's assertion rides the upgrade
// and uiAuth already checked it, so accepting anything else here would only add a second door.
const verifyWsSessionCookie = uiAuth.mode === "basic" ? verifySessionCookie : () => false;

let allowedRequestHosts: ReadonlySet<string>;
let allowedRequestOrigins: ReadonlySet<string>;
let apiHost: string | null;
try {
  allowedRequestHosts = trustedRequestHosts();
  allowedRequestOrigins = trustedRequestOrigins();
  apiHost = apiRequestHost();
} catch (err) {
  log.fatal(
    { event: "startup_trusted_hosts_invalid", outcome: "process_exit", err },
    "trusted HTTP hostname configuration is invalid — refusing to start",
  );
  exitAfterLogs(1);
}

// The roots this process will actually read and write, and whether it compiles on demand. Check
// this line first whenever the data on screen is not the data you expected.
log.info(
  {
    event: "runtime_mode_resolved",
    outcome: "runtime_mode_loaded",
    hotReload: runtimeMode.hotReload,
    workspacesVolume: runtimeMode.workspacesVolume,
    dataRoot: WORKSPACES_ROOT,
    providerVaultRoot: PROVIDER_VAULT_ROOT,
  },
  "runtime mode resolved",
);

log.info(
  {
    event: "capacity_guardrails_configured",
    outcome: "capacity_profile_loaded",
    maxConcurrentAgentRuns: executionCapacity.snapshot().limit,
    appMemoryLimit: capacityProfile.appMemoryLimit,
    appCpus: capacityProfile.appCpus,
    appPidsLimit: capacityProfile.appPidsLimit,
    workspaceMemoryLimitForNewContainers: capacityProfile.workspaceMemoryLimit,
    workspaceCpusForNewContainers: capacityProfile.workspaceCpus,
    workspacePidsLimitForNewContainers: capacityProfile.workspacePidsLimit,
  },
  "capacity guardrails configured",
);

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

// Thin adapter: extract the request primitives and delegate to the testable checkAuth. The platform
// credential is instance-wide, so it takes no subject; which routes it may reach is decided by
// platformAccessPolicy.ts inside checkAuth, not by the credential itself.
function authenticate(ip: string, req: import("http").IncomingMessage, hostname: string): AuthResult {
  return checkAuth(
    ip,
    authRequestFromIncoming(req, uiAuth.assertionHeader, hostname),
    uiAuth,
    authFailures,
    (plain) => validateCredential("platform", null, plain),
    apiHost,
  );
}

// Same adapter for the /ws upgrade, which additionally consults a cookie because no browser can put
// an Authorization header on a handshake and WebKit does not reuse cached Basic credentials either.
function authenticateWs(ip: string, req: import("http").IncomingMessage, hostname: string): AuthResult {
  const authRequest = authRequestFromIncoming(req, uiAuth.assertionHeader, hostname, true);
  return checkWsAuth(ip, authRequest, uiAuth, authFailures, verifyWsSessionCookie, apiHost);
}

// A mode with no challenge sends no header at all: behind an identity-aware proxy a browser prompt
// cannot satisfy the 401, and naming a scheme would advertise one this deployment does not accept.
function authenticateHeader(scheme: string | null): Record<string, string> {
  return scheme ? { "WWW-Authenticate": scheme } : {};
}

function setSecurityHeaders(res: import("http").ServerResponse): void {
  const headers = buildSecurityHeaders({
    isProduction: runtimeMode.hardenedBrowser,
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
const app = next({ dev: runtimeMode.hotReload, httpServer, port, webpack: true } as any);
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
    // and the reason, and it is already throttled. Emitting both just doubles the flood. This holds
    // only because every auditRejection call passes method and pathname — suppressing this line
    // while omitting them left denials with no route at all, so a source-level test in
    // lib/infra/auditRejectionContract.test.ts now enforces it.
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
    else if (!url.startsWith("/_next/") && !url.includes("/files/upload") && !url.includes("/background-tasks"))
      log.info(meta, "http request");
  };
  res.once("finish", logRequest);
  res.once("close", logRequest);

  setSecurityHeaders(res);
  res.setHeader("X-Request-Id", requestId);
  req.headers["x-request-id"] = requestId;

  // Security rejections happen before Next.js, so they cannot use the route-level response helper.
  // API callers still receive the identical public envelope; browser-page challenges retain their
  // terse text body and WWW-Authenticate behavior.
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

  // Rejection paths are reachable pre-auth, so an unauthenticated caller drives how often they log.
  // Throttle them and mark the request audited, so one rejected request costs at most one line.
  const auditRejection = (event: string, fields: Record<string, unknown>, msg: string) => {
    audited = true;
    const suppressed = throttleLog(event);
    if (suppressed !== null) audit.warn({ ...fields, event, suppressed }, msg);
  };

  const ip = getClientIp(req);
  const hostValidation = validateRequestHost(req.headers, allowedRequestHosts);
  if (!hostValidation.ok) {
    auditRejection(
      "request_host_rejected",
      { ip, method, pathname, reason: hostValidation.reason, requestId },
      "request host rejected",
    );
    reject(421, "INVALID_REQUEST", "Misdirected Request");
    return;
  }
  if (pathname.startsWith("/api/")) {
    const rl = checkApiRateLimit(ip, method, pathname);
    if (!rl.ok) {
      auditRejection(
        "api_rate_limited",
        { ip, method, pathname, policy: rl.policy, requestId },
        "API rate limit exceeded",
      );
      reject(429, "RATE_LIMITED", "Too Many Requests", {
        "Retry-After": String(rl.retryAfter),
        "RateLimit-Limit": String(rl.limit),
        "RateLimit-Remaining": String(rl.remaining),
      });
      return;
    }
  }

  const authResult = authenticate(ip, req, hostValidation.hostname);
  if (authResult === "blocked") {
    auditRejection("auth_blocked", { ip, method, pathname, requestId }, "auth blocked");
    reject(429, "RATE_LIMITED", "Too Many Requests", { "Retry-After": "60" });
    return;
  }
  if (authResult === "challenge") {
    audit.debug({ ip, requestId, event: "auth_challenge" }, "auth challenge");
    reject(401, "UNAUTHORIZED", "Unauthorized", authenticateHeader(uiAuth.challenge));
    return;
  }
  if (authResult === "unauthorized") {
    auditRejection("auth_unauthorized", { ip, method, pathname, requestId }, "auth unauthorized");
    const bearer = req.headers["authorization"]?.startsWith("Bearer ");
    // No UI challenge on the public API host: the credential it names is refused there, and
    // advertising it invites the confusion that made the password look like an identity on it.
    const uiChallenge = hostValidation.hostname === apiHost ? null : uiAuth.challenge;
    reject(401, "UNAUTHORIZED", "Unauthorized", authenticateHeader(bearer ? 'Bearer realm="PAODO"' : uiChallenge));
    return;
  }

  // No longer gated on an Authorization header: in `iap` mode a verified request carries none, and
  // the gate meant the one "auth works" line never appeared for the mode that most needs proving.
  if (authResult === "ok" && !authLoggedOnce) {
    authLoggedOnce = true;
    audit.info({ requestId, event: "auth_ok", authMode: uiAuth.mode }, "auth configured and working");
  }

  // Mint the /ws session cookie only in `basic` mode, and only for a verified UI credential.
  // Programmatic platform tokens and route-authenticated agent/MCP credentials never become sessions.
  if (uiAuth.mode === "basic" && authResult === "ok" && sessionCookieNeedsRefresh(req.headers["cookie"])) {
    res.setHeader("Set-Cookie", mintSessionCookie({ isProduction: runtimeMode.hardenedBrowser }));
  }

  if (isCsrf({ method, pathname, secFetchSite: req.headers["sec-fetch-site"] as string | undefined })) {
    auditRejection("csrf_blocked", { ip, method, pathname, requestId }, "csrf blocked");
    reject(403, "FORBIDDEN", "Forbidden");
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
    // Same throttle as the HTTP rejections, and the same reason: an upgrade is just as cheap to
    // repeat. The window is shared with the HTTP path — one flood, one line, whichever door it uses.
    const auditWsRejection = (event: string, msg: string) => {
      const suppressed = throttleLog(event);
      if (suppressed !== null) {
        audit.warn({ ip: wsIp, requestId, transport: "websocket", event, suppressed }, msg);
      }
    };
    const hostValidation = validateRequestHost(req.headers, allowedRequestHosts);
    if (!hostValidation.ok) {
      auditWsRejection("request_host_rejected", "request host rejected");
      socket.write("HTTP/1.1 421 Misdirected Request\r\n\r\n");
      socket.destroy();
      return;
    }
    // Before authentication, because the credential is the problem here: a handshake carries it
    // whoever opened the page, and an accepted socket is readable by that page. See httpAuth.ts.
    if (!validateRequestOrigin(req.headers.origin, allowedRequestOrigins)) {
      auditWsRejection("request_origin_rejected", "request origin rejected");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const wsAuthResult = authenticateWs(wsIp, req, hostValidation.hostname);
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
      if (msg.type === "self_write" && msg.path) markSelfWrite(workspace.dir, msg.path);
    } catch (err) {
      log.warn({ err, workspaceId, messageType: msg.type }, "websocket message handling failed");
    }
  });
});

// There is deliberately NO startup gate on LLM provider keys. Keys are entered in the app
// (Settings → Provider API keys), so a fresh deployment has none by definition — refusing to start
// would make the very screen that fixes it unreachable. A workspace with no usable provider fails at
// the start of its conversation instead, naming the provider and the fix (lib/agent/providerFailure.ts).

// Before the data root is touched: without the volume, every workspace mount would resolve against
// the daemon's host filesystem instead, and the app would run on state nothing else can see.
try {
  assertWorkspacesVolumeConfigured(runtimeMode.workspacesVolume);
} catch (err) {
  log.fatal(
    { event: "startup_workspaces_volume_unconfigured", outcome: "process_exit", err },
    "WORKSPACES_VOLUME_NAME is unset — start through docker compose, which sets it",
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

// Provision both recoverable-secret boundaries before creating the proxy CA. Seeing the CA is the
// sidecar's startup barrier, so its workspace-secret vault/key are ready before it proceeds. The
// provider vault/key are app-only and are never mounted into that sidecar.
try {
  assertSecretStorageSeparated(WORKSPACES_ROOT);
  assertDataRootAvailable(PROVIDER_VAULT_ROOT);
  assertDataRootAvailable(path.dirname(PROVIDER_VAULT_KEY_FILE));
  assertDataRootAvailable(WORKSPACE_SECRET_VAULT_ROOT);
  assertDataRootAvailable(path.dirname(WORKSPACE_SECRET_VAULT_KEY_FILE));
  getProviderVaultKey();
  getSecretsEncKey();
} catch (err) {
  log.fatal(
    {
      event: "startup_secret_vault_storage_unavailable",
      outcome: "process_exit",
      err,
      providerVaultRoot: PROVIDER_VAULT_ROOT,
      providerKeyFile: PROVIDER_VAULT_KEY_FILE,
      workspaceSecretVaultRoot: WORKSPACE_SECRET_VAULT_ROOT,
      workspaceSecretKeyFile: WORKSPACE_SECRET_VAULT_KEY_FILE,
    },
    "provider or workspace-secret vault storage is unavailable — refusing to start",
  );
  exitAfterLogs(1);
}

// Unconditional, like assertDataRootAvailable above. Each of these reports state that is present
// but unreadable, and all three treat a missing file as a first run — so a fresh clone is unaffected
// and the only thing a hot-reload exemption would buy is starting on top of corruption, which is
// worse here than in a deployed stack: this is where corruption gets made.
try {
  assertWorkspaceRegistryAvailable(WORKSPACES_ROOT);
} catch (err) {
  log.fatal(
    {
      event: "startup_workspace_registry_unavailable",
      outcome: "process_exit",
      err,
      filePath: workspaceRegistryFile(),
    },
    "existing workspace registry could not be read safely — refusing to start",
  );
  exitAfterLogs(1);
}
try {
  assertProviderVaultAvailable();
} catch (err) {
  log.fatal(
    {
      event: "startup_provider_vault_unavailable",
      outcome: "process_exit",
      err,
      filePath: PROVIDER_VAULT_FILE,
    },
    "existing encrypted provider vault could not be read safely — refusing to start",
  );
  exitAfterLogs(1);
}
try {
  assertWorkspaceSecretVaultAvailable();
} catch (err) {
  log.fatal(
    {
      event: "startup_workspace_secret_vault_unavailable",
      outcome: "process_exit",
      err,
      filePath: WORKSPACE_SECRET_VAULT_FILE,
    },
    "existing encrypted workspace-secret vault could not be read safely — refusing to start",
  );
  exitAfterLogs(1);
}

// Withdrawing a provider destroys its key, and this is where that happens: availability is read from
// .env, so it can only change across a restart. Running it before the server listens means no request
// and no scheduled run can spend on a provider the operator has just switched off.
//
// DESTRUCTIVE. Setting <PROVIDER>_AVAILABLE=false and restarting deletes that provider's stored key
// for good; switching it back on does not bring it back. That is what makes the switch mean "nobody
// can spend on this" rather than merely "hidden from the picker", and each deletion is audit-logged.
{
  const offered = availableProviders();
  const purged = purgeProviderKeysExcept(offered);
  if (purged.length) {
    log.warn(
      { event: "startup_provider_keys_purged", outcome: "stored_keys_destroyed", providers: purged },
      "deleted the stored API keys of providers this deployment has switched off",
    );
  }
  // A workspace already set to a provider this deployment has just switched off keeps a selection
  // nothing can honour — its key was destroyed a line ago — and the picker has no way to show that:
  // a withdrawn provider is absent from the catalog, so the row renders like any other and the run
  // fails on send. Clearing the selection here returns those workspaces to the default provider,
  // which is one .env does offer. Same restart-scoped reasoning as the purge: availability can only
  // change across a boot, so a sweep before the server listens leaves no window where a request or
  // a scheduled run reaches a stranded workspace.
  const stranded = getStore().clearWithdrawnLlmSelections(offered);
  if (stranded.length) {
    log.warn(
      {
        event: "startup_withdrawn_llm_selections_cleared",
        outcome: "workspaces_reset_to_default_model",
        workspaces: stranded,
      },
      "cleared the model selection of workspaces set to a provider this deployment has switched off",
    );
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

// Snapshots shell out to `git` and swallow the failure, so a missing binary disables version history
// invisibly — as it once did in production. Both runners install it, so absence means a broken image.
async function assertGitAvailable() {
  if (await getVersioning().isGitAvailable()) return;
  log.fatal(
    { event: "startup_git_unavailable", outcome: "process_exit" },
    "git is not available — workspace version history (snapshots) would silently no-op. Refusing to start.",
  );
  exitAfterLogs(1);
}

assertGitAvailable()
  .then(() => getContainers().assertDockerAvailable())
  .then(async () => {
    // The app owns CA generation (writable data mount); the credproxy sidecar only loads it.
    try {
      // Strict on both axes. Nothing on disk still generates a fresh CA, so a first run is
      // unaffected; what this refuses is silently replacing partial or unreadable material, which
      // invalidates the CA already baked into every existing workspace container at
      // /etc/proxy-ca.crt and rotates every derived proxy secret. That surfaces only as "the agent
      // lost internet". Remedy is `rm -rf data/.proxy-ca` plus recreating workspaces.
      ensureCA(WORKSPACES_ROOT, { strictExisting: true });
    } catch (err) {
      log.fatal(
        { event: "startup_proxy_key_material_invalid", outcome: "process_exit", err },
        "existing credential-proxy key material is incomplete or invalid — refusing to start",
      );
      exitAfterLogs(1);
    }
    // After ensureCA, which creates the directory this writes into. The sidecar waits for the file.
    try {
      reconcileInternetAccessPolicy(getStore().listWorkspaces());
    } catch (err) {
      log.fatal(
        { event: "startup_internet_access_policy_unwritable", outcome: "process_exit", err },
        "could not rebuild the internet-access policy the proxy enforces — refusing to start",
      );
      exitAfterLogs(1);
    }
    // The proxy runs in the `credproxy` sidecar, never in this process, so the app never joins a
    // workspace network. A redeploy recreates the sidecar and drops its attachments — reconnect
    // running workspaces so their egress keeps working.
    await getContainers().reattachProxyNetworks();
    // Boot-time reattach only heals sidecar recreations that coincide with an app restart. Keep a
    // reconcile loop running so an independent sidecar restart self-heals within one interval.
    startProxyReconciler();
    // In-memory idle timers are lost on restart. Re-arm the task-aware reaper for every container
    // that survived, so one left running through the restart still idles (and recovers task caps).
    await getContainers().resumeIdleReapers();
  })
  // Before the listener opens: in `iap` mode this fetches the provider's signing keys, and a failure
  // must stop the boot rather than leave every request failing closed against an empty key set.
  .then(() => uiAuth.prime())
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
    // Keep LLM rates current without a redeploy. A turn's cost is frozen when it is written, so a
    // stale rate is permanently wrong in the database rather than a display bug — see priceRefresher.
    startPriceRefresher();
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
    stopPriceRefresher();
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

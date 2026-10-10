// Custom entry point that runs Next.js and the WebSocket server on one manually created HTTP
// server: /ws upgrades go to the app, every other upgrade and request goes to Next.js.

import "dotenv/config";
import { createServer } from "http";
import path from "path";
import { createAuditLogger, createLogger, exitAfterLogs } from "./lib/infra/logger";

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
  trustedRequestHosts,
  trustedRequestOrigins,
  apiRequestHost,
} from "./lib/infra/security/httpAuth";
import { verifySessionCookie } from "./lib/infra/security/wsSession";
import { resolveUiAuth } from "./lib/infra/security/uiAuth";
import { createRequestGate } from "./lib/infra/server/requestGate";
import { createUpgradeGate } from "./lib/infra/server/upgradeGate";
import { createWorkspaceSocketHandler } from "./lib/infra/server/workspaceSocket";
import { startScheduler, stopScheduler } from "./lib/infra/schedules/scheduler";
import { startProxyReconciler, stopProxyReconciler } from "./lib/infra/docker/proxyReconciler";
import { startUploadSweeper, stopUploadSweeper } from "./lib/uploads/sweeper";
import { startNetworkReaper, stopNetworkReaper } from "./lib/infra/docker/networkReaper";
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

// Shared by both gates: a credential guessed over HTTP or over the /ws handshake counts toward the
// same per-IP lockout.
const authFailures = new AuthFailureTracker();

const httpServer = createServer();
// Node's 5-minute default would abort a large upload on a slow link with no reason given.
// headersTimeout keeps its default, so slowloris stays covered: only the body deadline relaxes.
httpServer.requestTimeout = 30 * 60_000;
httpServer.on("error", (err) => {
  log.fatal(
    { event: "startup_http_listener_failed", outcome: "process_exit", err, port },
    "HTTP listener failed — refusing to continue",
  );
  exitAfterLogs(1);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app = next({ dev: runtimeMode.hotReload, httpServer, port } as any);
const handle = app.getRequestHandler();

httpServer.on(
  "request",
  createRequestGate({
    uiAuth,
    allowedHosts: allowedRequestHosts,
    apiHost,
    authFailures,
    validatePlatformToken: (plain) => validateCredential("platform", null, plain),
    checkRateLimit: checkApiRateLimit,
    hardenedBrowser: runtimeMode.hardenedBrowser,
    handle,
    log,
    audit,
  }),
);

const wss = new WebSocketServer({ noServer: true });
wss.on("error", (err) =>
  log.error({ event: "websocket_server_error", outcome: "websocket_service_degraded", err }, "websocket server error"),
);

httpServer.on(
  "upgrade",
  createUpgradeGate({
    uiAuth,
    allowedHosts: allowedRequestHosts,
    allowedOrigins: allowedRequestOrigins,
    apiHost,
    authFailures,
    verifySessionCookie: verifyWsSessionCookie,
    accept: (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    },
    audit,
  }),
);

wss.on(
  "connection",
  createWorkspaceSocketHandler({
    getWorkspace: (workspaceId) => getStore().getWorkspace(workspaceId),
    connections: { add: addConnection, remove: removeConnection, count: getConnectionCount },
    loadConversations: loadIndex,
    watcher: { ensure: ensureWatcher, stop: stopWatcher, markSelfWrite },
    clearTodos: (workspaceId) => setTodos(workspaceId, []),
    log,
  }),
);

// Deliberately NO startup gate on LLM provider keys: they are entered in the app, so refusing to
// start would make the screen that fixes it unreachable. See lib/agent/providerFailure.ts.

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

// Both secret boundaries are provisioned before the proxy CA, which is the sidecar's startup
// barrier. The provider vault and key are app-only and never mounted into that sidecar.
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

// Unconditional: each reports state that is present but unreadable and treats a missing file as a
// first run, so a hot-reload exemption would only buy starting on top of corruption.
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

// DESTRUCTIVE: a provider switched off in .env has its stored key deleted here for good, and each
// deletion is audit-logged. Runs before the server listens, so nothing can spend on it.
{
  const offered = availableProviders();
  const purged = purgeProviderKeysExcept(offered);
  if (purged.length) {
    log.warn(
      { event: "startup_provider_keys_purged", outcome: "stored_keys_destroyed", providers: purged },
      "deleted the stored API keys of providers this deployment has switched off",
    );
  }
  // A workspace set to a withdrawn provider would fail on send with nothing in the picker to show
  // why. Clearing the selection before the server listens returns it to the default provider.
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
  // Opening the database applies every pending migration before anything can reach a feature
  // store. An incompatible schema is a startup failure, never a partially working application.
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
      // Strict: silently replacing partial or unreadable material would invalidate the CA baked into
      // every workspace container. Remedy: `rm -rf data/.proxy-ca` plus recreating workspaces.
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
    // The proxy runs in the `credproxy` sidecar, never here. A redeploy recreates it and drops its
    // network attachments, so reconnect running workspaces to keep their egress working.
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
    // Reclaim per-workspace networks that idle-stop left empty (see networkReaper — deleting them
    // inline on stop would blip the tunnel).
    startNetworkReaper();
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
    stopNetworkReaper();
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

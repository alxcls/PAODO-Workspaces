// Standalone entry point for the credential-proxy SIDECAR container (docker-compose service
// `credproxy`). In production the app runs inside its own container; hosting the proxy there would
// force the app onto every per-workspace network and hand the untrusted sandbox an L3 route to the
// control plane (0.0.0.0:3000 + /ws), defeating client-IP attribution and cross-workspace isolation.
// Instead this minimal process runs ONLY the proxy: the app attaches THIS container (never itself)
// to each workspace network, so port 9998 is the sole thing a workspace can reach.
//
// It shares no IPC with the app: it reads CA material, the encrypted vault and the master key from
// three separate read-only mounts and nothing else. It reloads rules when the vault changes. The
// app owns all generation and writes; this side only loads existing material.
import * as fs from "fs";
import * as path from "path";
import { createLogger, exitAfterLogs } from "./lib/infra/logger";
import { CredentialProxy } from "./lib/infra/proxy/credentialProxy";
import { ensureCA } from "./lib/infra/proxy/proxyCA";
import { WORKSPACES_ROOT } from "./lib/infra/paths";
import {
  assertSecretStoreAvailable,
  getWorkspaceRules,
  listSecretWorkspaceIds,
  reloadSecretStore,
  SECRET_STORE_FILE,
} from "./lib/infra/security/workspaceSecretStore";
import { reloadInternetAccessPolicy, INTERNET_ACCESS_POLICY_FILE } from "./lib/infra/proxy/internetAccessPolicy";

const log = createLogger("credproxyEntry");

// Mirrors server.ts. This sidecar is its own long-running process, so it needs its own handlers:
// the main().catch() at the bottom covers startup only, and once main() resolves everything runs
// on event-loop callbacks (the watchFile handler, every proxy socket). An unhandled throw there
// would kill the process with no log line at all, leaving a silent Docker restart loop.
function fatal(reason: string, err: unknown): never {
  log.fatal({ event: "process_fatal", outcome: "process_exit", err, reason }, "process exiting after fatal error");
  exitAfterLogs(1);
}

function fatalSecretStore(err: unknown): never {
  log.fatal(
    { event: "startup_secret_vault_unavailable", outcome: "process_exit", err, filePath: SECRET_STORE_FILE },
    "existing encrypted workspace-secret vault could not be read safely — refusing to start credential proxy",
  );
  exitAfterLogs(1);
}

function fatalProxyKeyMaterial(err: unknown): never {
  log.fatal(
    { event: "startup_proxy_key_material_invalid", outcome: "process_exit", err },
    "existing credential-proxy key material is incomplete or invalid — refusing to start",
  );
  exitAfterLogs(1);
}

function fatalProxyListener(err: unknown): never {
  log.fatal(
    { event: "credential_proxy_listener_failed", outcome: "process_exit", err, port: CREDENTIAL_PROXY_PORT },
    "credential proxy listener failed — exiting so the service can restart",
  );
  exitAfterLogs(1);
}

process.on("uncaughtException", (err) => fatal("uncaughtException", err));
process.on("unhandledRejection", (err) => fatal("unhandledRejection", err));

const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT ?? "9998", 10);
const CA_WAIT_INTERVAL_MS = 2000;
const CA_WAIT_WARN_AFTER_MS = 30_000;
// domain.key is the last file ensureCA writes, so its presence implies the whole CA set exists —
// use it as the barrier so we never fall into ensureCA's generate branch on the read-only mount.
const CA_SENTINEL = path.join(WORKSPACES_ROOT, ".proxy-ca", "domain.key");
// The policy is rewritten from the registry on every app boot. Starting between the CA write and
// that one would serve "everyone enabled" until the next poll — the fail-open case it exists to stop.
const STARTUP_FILES = [CA_SENTINEL, INTERNET_ACCESS_POLICY_FILE];

// The CA dir is mounted read-only, and on a first deployment it starts empty (compose creates the
// volume; only the app writes into it). Wait for the app to have written both before loading them.
async function waitForAppStartupFiles(): Promise<void> {
  const startedAt = Date.now();
  let delayedWarningEmitted = false;
  let missing = STARTUP_FILES.filter((f) => !fs.existsSync(f));
  while (missing.length > 0) {
    const waitedMs = Date.now() - startedAt;
    if (!delayedWarningEmitted && waitedMs >= CA_WAIT_WARN_AFTER_MS) {
      delayedWarningEmitted = true;
      log.warn(
        {
          event: "credential_proxy_ca_wait_delayed",
          outcome: "startup_waiting",
          waitedMs,
          missing,
        },
        "credential proxy is still waiting for the app to write its startup files",
      );
    } else {
      log.debug({ waitedMs, missing }, "waiting for proxy startup files to be created by the app");
    }
    await new Promise((r) => setTimeout(r, CA_WAIT_INTERVAL_MS));
    missing = STARTUP_FILES.filter((f) => !fs.existsSync(f));
  }
}

// Reload the on-disk secret store and (re)apply rules for every workspace; clear rules for any
// workspace whose secrets were all removed since the previous load. Returns the current id set.
function applyAllRules(proxy: CredentialProxy, previousIds: Set<string>): Set<string> {
  reloadSecretStore();
  const currentIds = new Set(listSecretWorkspaceIds());
  for (const wsId of currentIds) proxy.setRules(wsId, getWorkspaceRules(wsId));
  for (const wsId of previousIds) if (!currentIds.has(wsId)) proxy.clearRules(wsId);
  return currentIds;
}

async function main(): Promise<void> {
  try {
    assertSecretStoreAvailable();
  } catch (err) {
    fatalSecretStore(err);
  }
  await waitForAppStartupFiles();
  try {
    // files exist → load branch only (no writes to the RO mount)
    ensureCA(WORKSPACES_ROOT, { strictExisting: true });
  } catch (err) {
    fatalProxyKeyMaterial(err);
  }

  const proxy = new CredentialProxy({
    onServerError: fatalProxyListener,
  });
  proxy.listen(CREDENTIAL_PROXY_PORT);

  let ids = applyAllRules(proxy, new Set());
  // internetAccessPolicy's globalSingleton already loads INTERNET_ACCESS_POLICY_FILE at import time;
  // reload explicitly here (rather than relying on import ordering) so its first read happens at a
  // predictable point after the CA wait, matching how secret rules are applied above.
  reloadInternetAccessPolicy();
  log.info({ workspaces: ids.size, port: CREDENTIAL_PROXY_PORT }, "credential proxy sidecar ready");

  // Reload on secret change. watchFile (stat polling) is robust to atomicSaveJson's temp-then-rename
  // writes, which would invalidate an fs.watch inode watch.
  fs.watchFile(SECRET_STORE_FILE, { interval: 1000 }, () => {
    ids = applyAllRules(proxy, ids);
    log.info({ workspaces: ids.size }, "reloaded proxy rules after secret change");
  });

  // Same rationale, for the internet-access on/off policy — a separate file (internetAccessPolicy.ts)
  // since it's consulted before any rule/domain logic runs at all, not folded into the secret store.
  fs.watchFile(INTERNET_ACCESS_POLICY_FILE, { interval: 1000 }, () => {
    reloadInternetAccessPolicy();
    log.info("reloaded internet-access policy after change");
  });
}

main().catch((err) => {
  fatal("startup", err);
});

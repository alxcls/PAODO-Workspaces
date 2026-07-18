// Standalone entry point for the credential-proxy SIDECAR container (docker-compose service
// `credproxy`). In production the app runs inside its own container; hosting the proxy there would
// force the app onto every per-workspace network and hand the untrusted sandbox an L3 route to the
// control plane (0.0.0.0:3000 + /ws), defeating client-IP attribution and cross-workspace isolation.
// Instead this minimal process runs ONLY the proxy: the app attaches THIS container (never itself)
// to each workspace network, so port 9998 is the sole thing a workspace can reach.
//
// It shares no IPC with the app: it reads the same on-disk CA material and encrypted secret store
// from the read-only `workspaces` volume, and reloads rules when the secret file changes. The app
// owns CA generation (server.ts), so this side only ever loads it — never writes to the RO mount.
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "./lib/infra/logger";
import { CredentialProxy } from "./lib/infra/proxy/credentialProxy";
import { ensureCA } from "./lib/infra/proxy/proxyCA";
import { WORKSPACES_ROOT } from "./lib/infra/paths";
import {
  getWorkspaceRules,
  listSecretWorkspaceIds,
  reloadSecretStore,
  SECRET_STORE_FILE,
} from "./lib/infra/security/workspaceSecretStore";

const log = createLogger("credproxyEntry");

const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT ?? "9998", 10);
// domain.key is the last file ensureCA writes, so its presence implies the whole CA set exists —
// use it as the barrier so we never fall into ensureCA's generate branch on the read-only mount.
const CA_SENTINEL = path.join(WORKSPACES_ROOT, ".proxy-ca", "domain.key");

// The data dir is mounted read-only; wait for the app to have generated the CA before loading it.
async function waitForCA(): Promise<void> {
  while (!fs.existsSync(CA_SENTINEL)) {
    log.info("waiting for proxy CA to be created by the app…");
    await new Promise((r) => setTimeout(r, 2000));
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
  await waitForCA();
  ensureCA(WORKSPACES_ROOT); // files exist → load branch only (no writes to the RO mount)

  const proxy = new CredentialProxy();
  proxy.listen(CREDENTIAL_PROXY_PORT);

  let ids = applyAllRules(proxy, new Set());
  log.info({ workspaces: ids.size, port: CREDENTIAL_PROXY_PORT }, "credential proxy sidecar ready");

  // Reload on secret change. watchFile (stat polling) is robust to atomicSaveJson's temp-then-rename
  // writes, which would invalidate an fs.watch inode watch.
  fs.watchFile(SECRET_STORE_FILE, { interval: 1000 }, () => {
    ids = applyAllRules(proxy, ids);
    log.info({ workspaces: ids.size }, "reloaded proxy rules after secret change");
  });
}

main().catch((err) => {
  log.error({ err }, "credential proxy sidecar failed to start");
  process.exit(1);
});

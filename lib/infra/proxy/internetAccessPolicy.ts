// Per-workspace internet-access on/off policy, consulted by the credential proxy before any
// tunnel/forward — the application-layer half of the "off means no egress at all" guarantee (the
// other half is the workspace's Docker network being created --internal, see containerManager.ts).
//
// Persisted to disk (not just in-memory) because in production the proxy runs in a separate
// sidecar PROCESS (docker-compose `credproxy`) with no shared memory with the app — same reason
// workspaceSecretStore.ts exposes SECRET_STORE_FILE for proxyEntry.ts to poll. The app is the only
// writer; the sidecar only ever reloads (the shared volume is mounted read-only there).
import path from "path";
import { existsSync, readFileSync } from "fs";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createLogger } from "../logger";

const log = createLogger("internetAccessPolicy");
// Lives inside .proxy-ca/ so the sidecar can mount that one directory rather than the whole
// workspaces volume, which also holds the conversation database and every workspace's files.
const FILE = path.join(WORKSPACES_ROOT, ".proxy-ca", "internet-access.json");
const LEGACY_FILE = path.join(WORKSPACES_ROOT, ".internet-access.json");
export const INTERNET_ACCESS_POLICY_FILE = FILE;

// wsId -> enabled. Sparse: only "off" entries are ever written (see setInternetAccessPolicy), so an
// absent key means enabled — the safe default, matching WorkspaceMetadata.internetAccess's default.
type Store = Record<string, boolean>;

// Promote the pre-move file on first load. Nothing regenerates this from the registry, so a
// deployment that skipped it would silently switch every disabled workspace back on.
function loadPolicy(): Store {
  if (existsSync(FILE)) return readJson<Store>(FILE, {});
  const legacy = readJson<Store>(LEGACY_FILE, {});
  // Nothing to carry over, or we are the read-only sidecar (which cannot see the legacy path at
  // all): either way there is no write to attempt. The app is the only writer.
  if (Object.keys(legacy).length === 0) return legacy;
  try {
    atomicSaveJson(FILE, legacy);
    log.info(
      { event: "internet_access_policy_migrated", outcome: "policy_relocated", filePath: FILE },
      "moved the internet-access policy into .proxy-ca",
    );
  } catch (err) {
    log.error(
      { event: "internet_access_policy_migration_failed", outcome: "policy_not_relocated", err, filePath: FILE },
      "failed to move the internet-access policy — the sidecar will not see it until this succeeds",
    );
  }
  return legacy;
}

// Fixed reference, shared across every module instance via globalSingleton — mutated in place
// everywhere below (never reassigned) so all instances keep seeing the same state.
const store: Store = globalSingleton<Store>("internetAccessPolicy", loadPolicy);

export function setInternetAccessPolicy(wsId: string, enabled: boolean): void {
  if (enabled) delete store[wsId];
  else store[wsId] = false;
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.error(
      { event: "internet_access_policy_save_failed", outcome: "policy_change_not_persisted", err, wsId },
      "failed to persist internet-access policy",
    );
    throw err;
  }
}

export function isInternetAccessEnabled(wsId: string): boolean {
  return store[wsId] !== false;
}

export function deleteInternetAccessPolicy(wsId: string): void {
  if (!(wsId in store)) return;
  delete store[wsId];
  atomicSaveJson(FILE, store);
}

// Sidecar-only: re-read the on-disk policy into memory. Unlike reloadSecretStore (where an empty
// store is the safe "no injection" fallback), an empty policy store means "everyone enabled" — so a
// transient read/parse failure here must NOT reset `store`, or a workspace that was correctly
// blocked could briefly fail open. On failure we log and keep serving the last-known-good state;
// only a successful read replaces it, in place, for the same globalSingleton-sharing reason as above.
export function reloadInternetAccessPolicy(): void {
  let next: Store;
  try {
    next = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error(
        { event: "internet_access_policy_reload_failed", outcome: "policy_unchanged", err, filePath: FILE },
        "failed to reload internet-access policy — keeping last-known-good state",
      );
      return;
    }
    next = {}; // missing file is the normal "nothing ever toggled off" case
  }
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, next);
}

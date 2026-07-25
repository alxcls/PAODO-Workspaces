// Per-workspace internet-access on/off policy, consulted by the credential proxy before any
// tunnel/forward — the application-layer half of the "off means no egress at all" guarantee (the
// other half is the workspace's Docker network being created --internal, see containerManager.ts).
//
// Persisted to disk (not just in-memory) because in production the proxy runs in a separate
// sidecar PROCESS (docker-compose `credproxy`) with no shared memory with the app — same reason
// workspaceSecretStore.ts exposes SECRET_STORE_FILE for proxyEntry.ts to poll. The app is the only
// writer; the sidecar only ever reloads (the shared volume is mounted read-only there).
import path from "path";
import { readFileSync } from "fs";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createLogger } from "../logger";

const log = createLogger("internetAccessPolicy");
const FILE = path.join(WORKSPACES_ROOT, ".internet-access.json");
export const INTERNET_ACCESS_POLICY_FILE = FILE;

// wsId -> enabled. Sparse: only "off" entries are ever written (see setInternetAccessPolicy), so an
// absent key means enabled — the safe default, matching WorkspaceMetadata.internetAccess's default.
type Store = Record<string, boolean>;

// Fixed reference, shared across every module instance via globalSingleton — mutated in place
// everywhere below (never reassigned) so all instances keep seeing the same state.
const store: Store = globalSingleton<Store>("internetAccessPolicy", () => readJson<Store>(FILE, {}));

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

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
// Lives inside .proxy-ca/ so the sidecar can mount that one directory rather than the whole
// workspaces volume, which also holds the conversation database and every workspace's files.
const FILE = path.join(WORKSPACES_ROOT, ".proxy-ca", "internet-access.json");
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

/** A workspace as the registry records it. The registry is the primary record; this file mirrors it. */
export interface InternetAccessRecord {
  id: string;
  internetAccess?: boolean;
}

/**
 * Rebuild the mirror from the registry. The app calls this at startup, before the sidecar can read
 * the file, because the two records are one security boundary and only the registry survives losing
 * the .proxy-ca volume or a restore from backup. A missing entry here reads as ENABLED, so a mirror
 * that is absent or behind silently reopens a workspace the UI still shows as off — the one drift
 * direction that fails open. Throws if the rebuilt file cannot be written or read back intact;
 * startup treats that as fatal rather than serving egress the registry says is off.
 */
export function reconcileInternetAccessPolicy(workspaces: InternetAccessRecord[]): void {
  const off = new Set(workspaces.filter((w) => w.internetAccess === false).map((w) => w.id));
  const restored = [...off].filter((id) => store[id] !== false);
  const dropped = Object.keys(store).filter((id) => !off.has(id));

  for (const id of dropped) delete store[id];
  for (const id of off) store[id] = false;
  atomicSaveJson(FILE, store);

  // Read back rather than trust the write: this file is the sidecar's only view of the boundary,
  // and it is the app's last chance to notice the volume is not holding what it was handed.
  const persisted = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  const persistedIds = Object.keys(persisted);
  if (persistedIds.length !== off.size || persistedIds.some((id) => !off.has(id) || persisted[id] !== false)) {
    throw new Error("internet-access policy did not persist as written");
  }

  if (restored.length > 0 || dropped.length > 0) {
    log.warn(
      { event: "internet_access_policy_reconciled", outcome: "policy_rebuilt_from_registry", restored, dropped },
      "internet-access mirror disagreed with the workspace registry — rebuilt from the registry",
    );
    return;
  }
  log.info(
    { event: "internet_access_policy_verified", outcome: "policy_matches_registry", disabled: off.size },
    "internet-access mirror matches the workspace registry",
  );
}

// Sidecar-only: re-read the on-disk policy into memory, replacing it in place for the same
// globalSingleton-sharing reason as above. Only a successful read replaces the served state.
export function reloadInternetAccessPolicy(): void {
  let next: Store;
  try {
    next = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch (err) {
    // ENOENT included: the app writes this file on every boot and the sidecar waits for it, so a
    // vanished or corrupt file is an anomaly — resetting to empty would re-enable every workspace.
    log.error(
      { event: "internet_access_policy_reload_failed", outcome: "policy_unchanged", err, filePath: FILE },
      "failed to reload internet-access policy — keeping last-known-good state",
    );
    return;
  }
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, next);
}

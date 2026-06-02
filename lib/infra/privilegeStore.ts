// Per-workspace registry of privileged scripts — scripts the user has authorized to run with
// elevated privilege (workspace secrets injected, via `docker exec -u root`).
//
// Only the user can grant a script privilege (through the file-tree key icon); the agent has no
// tool to do so. Granting privilege also LOCKS the script on disk (root-owned, see osLock) so
// the agent cannot edit it to leak the injected secret. Stored as PLAINTEXT relative paths in a
// JSON file outside any workspace's bind mount. Same global-cached, atomic-write pattern as
// apiKeyStore / permissionStore.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("privilege");

// Derived independently (not imported from workspaceStore) to keep this leaf module free of the
// workspaceStore → containerManager import chain. Same pattern as secretStore.
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");
const FILE = path.join(WORKSPACES_ROOT, ".privileged-scripts.json");

// workspaceId -> [relPath, ...]
type Store = Record<string, string[]>;

const g = global as typeof global & { _privileged?: Store };
if (!g._privileged) {
  try {
    g._privileged = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch {
    g._privileged = {};
  }
}
const store = g._privileged;

function save() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, FILE);
  } catch (err) {
    log.error({ err }, "failed to save privilege store");
    throw err;
  }
}

export function grantPrivilege(workspaceId: string, relPath: string): void {
  const list = (store[workspaceId] ??= []);
  if (!list.includes(relPath)) {
    list.push(relPath);
    save();
    log.info({ workspaceId, relPath }, "script granted privilege");
  }
}

export function revokePrivilege(workspaceId: string, relPath: string): void {
  const list = store[workspaceId];
  if (!list) return;
  const idx = list.indexOf(relPath);
  if (idx !== -1) {
    list.splice(idx, 1);
    if (list.length === 0) delete store[workspaceId];
    save();
    log.info({ workspaceId, relPath }, "script privilege revoked");
  }
}

// True if relPath is privileged, OR lives under a privileged directory (prefix match), so granting
// privilege to a folder covers the scripts within it.
export function isPrivileged(workspaceId: string, relPath: string): boolean {
  const list = store[workspaceId];
  if (!list) return false;
  return list.some((p) => p === relPath || relPath.startsWith(p + "/"));
}

export function listPrivileged(workspaceId: string): string[] {
  return [...(store[workspaceId] ?? [])];
}

// Per-workspace registry of "secured" scripts — scripts the user has authorized to run with
// workspace secrets injected, via `docker exec -u root` (the `run_secured_script` tool).
//
// Only the user can secure a script (through the file-tree key icon); the agent has no tool to
// secure. Securing also LOCKS the script on disk (root-owned, see osLock) so the agent cannot edit
// it to leak the secret. Stored as PLAINTEXT relative paths in a JSON file outside any workspace's
// bind mount. Same global-cached, atomic-write pattern as apiKeyStore / permissionStore.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("secured");

// Derived independently (not imported from workspaceStore) to keep this leaf module free of the
// workspaceStore → containerManager import chain. Same pattern as secretStore.
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");
const FILE = path.join(WORKSPACES_ROOT, ".secured-scripts.json");

// workspaceId -> [relPath, ...]
type Store = Record<string, string[]>;

const g = global as typeof global & { _secured?: Store };
if (!g._secured) {
  try {
    g._secured = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch {
    g._secured = {};
  }
}
const store = g._secured;

function save() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, FILE);
  } catch (err) {
    log.error({ err }, "failed to save secured script store");
    throw err;
  }
}

export function secureScript(workspaceId: string, relPath: string): void {
  const list = (store[workspaceId] ??= []);
  if (!list.includes(relPath)) {
    list.push(relPath);
    save();
    log.info({ workspaceId, relPath }, "script secured");
  }
}

export function unsecureScript(workspaceId: string, relPath: string): void {
  const list = store[workspaceId];
  if (!list) return;
  const idx = list.indexOf(relPath);
  if (idx !== -1) {
    list.splice(idx, 1);
    if (list.length === 0) delete store[workspaceId];
    save();
    log.info({ workspaceId, relPath }, "script unsecured");
  }
}

// True if relPath is secured, OR lives under a secured directory (prefix match), so securing a
// folder covers the scripts within it.
export function isSecured(workspaceId: string, relPath: string): boolean {
  const list = store[workspaceId];
  if (!list) return false;
  return list.some((p) => p === relPath || relPath.startsWith(p + "/"));
}

export function listSecured(workspaceId: string): string[] {
  return [...(store[workspaceId] ?? [])];
}

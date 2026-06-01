// Per-workspace registry of "crowned" scripts — scripts the user has authorized to run with
// workspace secrets injected, via `docker exec -u root` (the `run_crowned_script` tool).
//
// Only the user can crown a script (through the file-tree crown icon); the agent has no tool to
// crown. Crowning also LOCKS the script on disk (root-owned, see osLock) so the agent cannot edit
// it to leak the secret. Stored as PLAINTEXT relative paths in a JSON file outside any workspace's
// bind mount. Same global-cached, atomic-write pattern as apiKeyStore / permissionStore.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("crowned");

// Derived independently (not imported from workspaceStore) to keep this leaf module free of the
// workspaceStore → containerManager import chain. Same pattern as secretStore.
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");
const FILE = path.join(WORKSPACES_ROOT, ".crowned-scripts.json");

// workspaceId -> [relPath, ...]
type Store = Record<string, string[]>;

const g = global as typeof global & { _crowned?: Store };
if (!g._crowned) {
  try {
    g._crowned = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch {
    g._crowned = {};
  }
}
const store = g._crowned;

function save() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, FILE);
  } catch (err) {
    log.error({ err }, "failed to save crowned script store");
    throw err;
  }
}

export function crownScript(workspaceId: string, relPath: string): void {
  const list = (store[workspaceId] ??= []);
  if (!list.includes(relPath)) {
    list.push(relPath);
    save();
    log.info({ workspaceId, relPath }, "script crowned");
  }
}

export function uncrownScript(workspaceId: string, relPath: string): void {
  const list = store[workspaceId];
  if (!list) return;
  const idx = list.indexOf(relPath);
  if (idx !== -1) {
    list.splice(idx, 1);
    if (list.length === 0) delete store[workspaceId];
    save();
    log.info({ workspaceId, relPath }, "script uncrowned");
  }
}

// True if relPath is crowned, OR lives under a crowned directory (prefix match), so crowning a
// folder covers the scripts within it.
export function isCrowned(workspaceId: string, relPath: string): boolean {
  const list = store[workspaceId];
  if (!list) return false;
  return list.some((p) => p === relPath || relPath.startsWith(p + "/"));
}

export function listCrowned(workspaceId: string): string[] {
  return [...(store[workspaceId] ?? [])];
}

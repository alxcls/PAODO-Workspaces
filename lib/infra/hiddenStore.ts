// Per-workspace registry of "hidden" files — files whose CONTENT the user wants invisible to the
// agent while still present in the workspace. The agent sees the name (tagged [H]) but can never
// read the bytes: hidden paths are made root-owned and group-readable only by the app server (see
// osLock.hideOnDisk), so `developer` (the agent's identity) is blocked at the kernel level — via
// file_read, cat, grep, or any shell command. A privileged (root) script can still consume them, and
// the user still views them through the file-tree viewer.
//
// Hiding also makes the path root-owned (so it's unwritable by the agent). Hidden is independent of
// lock and privilege: a hidden file may also be [R], [P], or any combination. A hidden+privileged
// file stays invisible to the agent — since non-privileged scripts run as `developer`, it remains
// unreadable even when executed. Stored as PLAINTEXT relative paths in a JSON file outside any
// workspace's bind mount. Same global-cached, atomic-write pattern as privilegeStore / permissionStore.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("hidden");

// Derived independently to keep this leaf module free of the workspaceStore → containerManager
// import chain. Same pattern as privilegeStore.
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");
const FILE = path.join(WORKSPACES_ROOT, ".hidden-files.json");

// workspaceId -> [relPath, ...]
type Store = Record<string, string[]>;

const g = global as typeof global & { _hidden?: Store };
if (!g._hidden) {
  try {
    g._hidden = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch {
    g._hidden = {};
  }
}
const store = g._hidden;

function save() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, FILE);
  } catch (err) {
    log.error({ err }, "failed to save hidden file store");
    throw err;
  }
}

export function hideFile(workspaceId: string, relPath: string): void {
  const list = (store[workspaceId] ??= []);
  if (!list.includes(relPath)) {
    list.push(relPath);
    save();
    log.info({ workspaceId, relPath }, "file hidden");
  }
}

export function unhideFile(workspaceId: string, relPath: string): void {
  const list = store[workspaceId];
  if (!list) return;
  const idx = list.indexOf(relPath);
  if (idx !== -1) {
    list.splice(idx, 1);
    if (list.length === 0) delete store[workspaceId];
    save();
    log.info({ workspaceId, relPath }, "file unhidden");
  }
}

// True if relPath is hidden, OR lives under a hidden directory (prefix match), so hiding a folder
// covers everything within it.
export function isHidden(workspaceId: string, relPath: string): boolean {
  const list = store[workspaceId];
  if (!list) return false;
  return list.some((p) => p === relPath || relPath.startsWith(p + "/"));
}

export function listHidden(workspaceId: string): string[] {
  return [...(store[workspaceId] ?? [])];
}

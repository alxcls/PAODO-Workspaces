// Per-workspace file permission store, persisted to `.agent-permissions/<workspaceId>.json`.
// Tracks a global read-only lock and a list of individually locked paths (files or directories).
// The agent checks these before writing; the UI exposes controls to set or lift locks.
import fs from "fs/promises";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("permissions");

const WORKSPACES_ROOT = path.resolve(process.cwd(), "./data");
const PERMISSIONS_DIR = path.join(WORKSPACES_ROOT, ".agent-permissions");

function getStorePath(workspaceId: string): string {
  return path.join(PERMISSIONS_DIR, `${workspaceId}.json`);
}

interface PermStore {
  globalLock: boolean;
  locked: string[]; // relative paths (files or directories)
}

async function readStore(workspaceId: string): Promise<PermStore> {
  try {
    const raw = await fs.readFile(getStorePath(workspaceId), "utf8");
    return JSON.parse(raw) as PermStore;
  } catch {
    return { globalLock: false, locked: [] };
  }
}

async function writeStore(workspaceId: string, store: PermStore): Promise<void> {
  const storePath = getStorePath(workspaceId);
  try {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
  } catch (err) {
    log.error({ err, workspaceId }, "failed to write permission store");
    throw err;
  }
}

export async function isAgentLocked(workspaceId: string, workspaceDir: string, absPath: string): Promise<boolean> {
  const rel = path.relative(workspaceDir, absPath);
  const store = await readStore(workspaceId);
  if (store.globalLock) return true;

  const parts = rel.split(path.sep);
  for (let i = 1; i <= parts.length; i++) {
    if (store.locked.includes(parts.slice(0, i).join(path.sep))) return true;
  }
  return false;
}

// Read-only snapshot helper to avoid repeated disk reads during large tree walks.
export async function readPermissionSnapshot(workspaceId: string): Promise<{ globalLock: boolean; locked: string[] }> {
  return readStore(workspaceId);
}

export async function setPermission(
  workspaceId: string,
  relPath: string,
  perm: "R" | "RW"
): Promise<void> {
  const store = await readStore(workspaceId);
  if (perm === "R") {
    if (!store.locked.includes(relPath)) store.locked.push(relPath);
  } else {
    store.locked = store.locked.filter(
      (p) => p !== relPath && !p.startsWith(relPath + path.sep)
    );
  }
  await writeStore(workspaceId, store);
}

export async function setGlobalPermission(
  workspaceId: string,
  perm: "R" | "RW"
): Promise<void> {
  const store = await readStore(workspaceId);
  store.globalLock = perm === "R";
  store.locked = [];
  await writeStore(workspaceId, store);
}

export async function getGlobalLock(workspaceId: string): Promise<boolean> {
  const store = await readStore(workspaceId);
  return store.globalLock;
}

// Per-workspace file permission store, persisted to `.agent-permissions/<workspaceId>.json`.
// Tracks a global read-only lock, individually locked/hidden paths, and keyed (privileged) paths.
// Eye/Lock are OS-enforced (chown/chmod via osLock.reconcileOsPermissions); Key is server-dispatched.
import fs from "fs/promises";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("permissions");

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");
const PERMISSIONS_DIR = path.join(WORKSPACES_ROOT, ".agent-permissions");

function getStorePath(workspaceId: string): string {
  return path.join(PERMISSIONS_DIR, `${workspaceId}.json`);
}

interface PermStore {
  globalLock: boolean;
  locked: string[]; // relative paths (files or directories)
  hidden: string[]; // Eye-off: agent cannot read; appuser (1002) and privd (998) can
  keyed: string[];  // Key: scripts run as privd (uid 998) via server dispatch
}

async function readStore(workspaceId: string): Promise<PermStore> {
  try {
    const raw = await fs.readFile(getStorePath(workspaceId), "utf8");
    const parsed = JSON.parse(raw) as Partial<PermStore>;
    return {
      globalLock: parsed.globalLock ?? false,
      locked: parsed.locked ?? [],
      hidden: parsed.hidden ?? [],
      keyed: parsed.keyed ?? [],
    };
  } catch {
    return { globalLock: false, locked: [], hidden: [], keyed: [] };
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

// --- Snapshot-level helpers (pure, no I/O — reuse a pre-fetched snapshot) ---

export function isLockedFromSnapshot(
  snapshot: Pick<PermStore, "globalLock" | "locked">,
  relPath: string,
): boolean {
  if (snapshot.globalLock) return true;
  const parts = relPath.split("/");
  for (let i = 1; i <= parts.length; i++) {
    if (snapshot.locked.includes(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

export function hasLockedDescendantFromSnapshot(
  snapshot: Pick<PermStore, "locked" | "keyed">,
  relPath: string,
): boolean {
  const prefixes = [...snapshot.locked, ...snapshot.keyed];
  if (!prefixes.length) return false;
  if (!relPath || relPath === ".") return prefixes.length > 0;
  const target = relPath.endsWith("/") ? relPath : `${relPath}/`;
  return prefixes.some((p) => p === relPath || p.startsWith(target));
}

export function isHiddenFromSnapshot(
  snapshot: Pick<PermStore, "hidden">,
  relPath: string,
): boolean {
  const parts = relPath.split("/");
  for (let i = 1; i <= parts.length; i++) {
    if (snapshot.hidden.includes(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

export function isKeyedFromSnapshot(
  snapshot: Pick<PermStore, "keyed">,
  relPath: string,
): boolean {
  const parts = relPath.split("/");
  for (let i = 1; i <= parts.length; i++) {
    if (snapshot.keyed.includes(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

// --- Async helpers (each reads the store once) ---

export async function isAgentLocked(workspaceId: string, workspaceDir: string, absPath: string): Promise<boolean> {
  const rel = path.relative(workspaceDir, absPath).split(path.sep).join("/");
  const store = await readStore(workspaceId);
  return isLockedFromSnapshot(store, rel);
}

export async function hasAgentLockedDescendant(
  workspaceId: string,
  workspaceDir: string,
  absPath: string,
): Promise<boolean> {
  const rel = path.relative(workspaceDir, absPath).split(path.sep).join("/") || ".";
  const store = await readStore(workspaceId);
  return hasLockedDescendantFromSnapshot(store, rel);
}

export async function isAgentHidden(workspaceId: string, workspaceDir: string, absPath: string): Promise<boolean> {
  const rel = path.relative(workspaceDir, absPath).split(path.sep).join("/");
  const store = await readStore(workspaceId);
  return isHiddenFromSnapshot(store, rel);
}

export async function isKeyed(workspaceId: string, relPath: string): Promise<boolean> {
  const store = await readStore(workspaceId);
  return isKeyedFromSnapshot(store, relPath);
}

// Read-only snapshot of the full permission state. Callers use snapshot helpers above
// to avoid repeated disk reads during large tree walks.
export async function readPermissionSnapshot(workspaceId: string): Promise<PermStore> {
  return readStore(workspaceId);
}

function isSamePath(entry: string, rel: string): boolean {
  return entry === rel;
}

function isDescendant(entry: string, rel: string): boolean {
  if (rel === ".") return false;
  return entry.startsWith(`${rel}/`);
}

export async function setPermission(
  workspaceId: string,
  relPath: string,
  perm: "R" | "RW",
): Promise<void> {
  const store = await readStore(workspaceId);
  if (perm === "R") {
    if (!store.locked.some((p) => isSamePath(p, relPath))) store.locked.push(relPath);
  } else {
    store.locked = store.locked.filter((p) => !isSamePath(p, relPath) && !isDescendant(p, relPath));
    store.keyed = store.keyed.filter((p) => !isSamePath(p, relPath) && !isDescendant(p, relPath));
  }
  await writeStore(workspaceId, store);
}

export async function setHidden(workspaceId: string, relPath: string, hidden: boolean): Promise<void> {
  const store = await readStore(workspaceId);
  if (hidden) {
    if (!store.hidden.some((p) => isSamePath(p, relPath))) store.hidden.push(relPath);
  } else {
    store.hidden = store.hidden.filter((p) => !isSamePath(p, relPath) && !isDescendant(p, relPath));
  }
  await writeStore(workspaceId, store);
}

export async function setKeyed(workspaceId: string, relPath: string, keyed: boolean): Promise<void> {
  const store = await readStore(workspaceId);
  if (keyed) {
    if (!store.keyed.some((p) => isSamePath(p, relPath))) store.keyed.push(relPath);
  } else {
    store.keyed = store.keyed.filter((p) => !isSamePath(p, relPath) && !isDescendant(p, relPath));
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
  if (perm === "RW") {
    store.keyed = [];
  }
  await writeStore(workspaceId, store);
}

export async function getGlobalLock(workspaceId: string): Promise<boolean> {
  const store = await readStore(workspaceId);
  return store.globalLock;
}

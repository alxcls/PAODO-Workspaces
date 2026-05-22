import fs from "fs/promises";
import path from "path";

const WORKSPACES_ROOT = path.resolve(process.cwd(), "./data");
const STORE_FILE = ".agent-permissions.json";
const PERMISSIONS_DIR = path.join(WORKSPACES_ROOT, ".agent-permissions");

function getStorePath(workspaceId: string): string {
  return path.join(PERMISSIONS_DIR, `${workspaceId}.json`);
}

function getLegacyStorePath(workspaceDir: string): string {
  return path.join(workspaceDir, STORE_FILE);
}

interface PermStore {
  globalLock: boolean;
  locked: string[]; // relative paths (files or directories)
}

async function readStore(workspaceId: string, workspaceDir: string): Promise<PermStore> {
  const storePath = getStorePath(workspaceId);
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw) as PermStore;
  } catch {
    const legacyPath = getLegacyStorePath(workspaceDir);
    try {
      const raw = await fs.readFile(legacyPath, "utf8");
      const parsed = JSON.parse(raw) as PermStore;
      await writeStore(workspaceId, parsed);
      await fs.rm(legacyPath).catch(() => {});
      return parsed;
    } catch {
      return migrateFromFilesystem(workspaceId, workspaceDir);
    }
  }
}

async function migrateFromFilesystem(workspaceId: string, workspaceDir: string): Promise<PermStore> {
  const locked: string[] = [];

  async function scan(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === STORE_FILE) continue;
      if (e.name === "AGENTS.md") continue;
      const full = path.join(dir, e.name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (!(stat.mode & 0o200)) {
        locked.push(path.relative(workspaceDir, full));
        await fs.chmod(full, e.isDirectory() ? 0o755 : 0o644).catch(() => {});
      }
      if (e.isDirectory()) await scan(full);
    }
  }

  await scan(workspaceDir);
  const store: PermStore = { globalLock: false, locked };
  await writeStore(workspaceId, store);
  await fs.rm(getLegacyStorePath(workspaceDir)).catch(() => {});
  return store;
}

async function writeStore(workspaceId: string, store: PermStore): Promise<void> {
  const storePath = getStorePath(workspaceId);
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

export async function isAgentLocked(workspaceId: string, workspaceDir: string, absPath: string): Promise<boolean> {
  const rel = path.relative(workspaceDir, absPath);
  if (rel === "AGENTS.md") return true;

  const store = await readStore(workspaceId, workspaceDir);
  if (store.globalLock) return true;

  // Check if path or any ancestor directory is in the locked list
  const parts = rel.split(path.sep);
  for (let i = 1; i <= parts.length; i++) {
    if (store.locked.includes(parts.slice(0, i).join(path.sep))) return true;
  }
  return false;
}

export async function setPermission(
  workspaceId: string,
  workspaceDir: string,
  relPath: string,
  perm: "R" | "RW"
): Promise<void> {
  const store = await readStore(workspaceId, workspaceDir);
  if (perm === "R") {
    if (!store.locked.includes(relPath)) store.locked.push(relPath);
  } else {
    // Remove the path and any children that were individually locked under it
    store.locked = store.locked.filter(
      (p) => p !== relPath && !p.startsWith(relPath + path.sep)
    );
  }
  await writeStore(workspaceId, store);
}

export async function setGlobalPermission(
  workspaceId: string,
  workspaceDir: string,
  perm: "R" | "RW"
): Promise<void> {
  const store = await readStore(workspaceId, workspaceDir);
  store.globalLock = perm === "R";
  store.locked = [];
  await writeStore(workspaceId, store);
}

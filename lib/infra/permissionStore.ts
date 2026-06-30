// State of record for the per-file agent permission model: which workspace paths are locked
// (read-only to the agent), hidden (unreadable by the agent), or privileged (a trusted script the
// agent may only run via run_privileged_script, executed as the non-root `privd` user).
//
// Persisted as JSON OUTSIDE the workspace bind mount (sibling of the workspace dir under
// WORKSPACES_ROOT/.agent-permissions/), so the agent has no path to read or tamper with it. The
// on-disk OS ownership/modes are derived from this store by lib/infra/osLock.ts; this file is the
// single source of truth and owns the state invariants — the OS layer is a pure projection of it.
//
// See doc/adr/accepted/adr-agent-permission-model.md.
import fs from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "./paths";
import { atomicSaveJson } from "./jsonPersist";

export type PermissionControl = "lock" | "hide" | "privilege";

export interface WorkspacePermissions {
  /** Paths the agent can read/execute but not modify or delete. */
  locked: string[];
  /** Paths whose content the agent cannot read (name stays visible in the tree). */
  hidden: string[];
  /** Trusted scripts: agent runs them only via run_privileged_script (executed as privd). */
  privileged: string[];
}

const PERMISSIONS_DIR = path.join(WORKSPACES_ROOT, ".agent-permissions");

// In-memory cache. Mirrors the on-disk JSON; both are updated together on every mutation.
const cache = new Map<string, WorkspacePermissions>();

function filePath(workspaceId: string): string {
  return path.join(PERMISSIONS_DIR, `${workspaceId}.json`);
}

function empty(): WorkspacePermissions {
  return { locked: [], hidden: [], privileged: [] };
}

// Normalizes a workspace-relative path to the canonical form used as a store key: posix, no leading
// "./" or "/", no trailing slash. Returns null for paths that escape the workspace root.
export function normalizePermPath(relPath: string): string | null {
  const normalized = path.posix.normalize(relPath.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (normalized.startsWith("..") || normalized.startsWith("/") || normalized === "" || normalized === ".")
    return null;
  return normalized;
}

export function getPermissions(workspaceId: string): WorkspacePermissions {
  const cached = cache.get(workspaceId);
  if (cached) return cached;
  let loaded = empty();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(workspaceId), "utf-8")) as Partial<WorkspacePermissions>;
    loaded = {
      locked: Array.isArray(raw.locked) ? raw.locked : [],
      hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
      privileged: Array.isArray(raw.privileged) ? raw.privileged : [],
    };
  } catch {
    // No file yet (or unreadable) — start empty.
  }
  cache.set(workspaceId, loaded);
  return loaded;
}

function persist(workspaceId: string, perms: WorkspacePermissions): void {
  cache.set(workspaceId, perms);
  atomicSaveJson(filePath(workspaceId), perms);
}

const add = (list: string[], p: string): string[] => (list.includes(p) ? list : [...list, p]);
const remove = (list: string[], p: string): string[] => list.filter((x) => x !== p);

/**
 * Apply a permission control to a path and persist. Returns the new state.
 *
 * Coupling rules (the only ones — hidden is fully independent):
 *  - privilege ON   → also lock (the agent must not be able to tamper with a trusted script).
 *  - privilege OFF  → metadata only; the lock stays until explicitly unlocked.
 *  - unlock (lock OFF) → also revoke privilege ([RW] + [P] is not a valid combination).
 */
export function setControl(
  workspaceId: string,
  relPath: string,
  control: PermissionControl,
  value: boolean,
): WorkspacePermissions {
  const key = normalizePermPath(relPath);
  if (key === null) throw new Error(`invalid path: ${relPath}`);
  const prev = getPermissions(workspaceId);
  const next: WorkspacePermissions = {
    locked: [...prev.locked],
    hidden: [...prev.hidden],
    privileged: [...prev.privileged],
  };

  switch (control) {
    case "hide":
      next.hidden = value ? add(next.hidden, key) : remove(next.hidden, key);
      break;
    case "lock":
      if (value) {
        next.locked = add(next.locked, key);
      } else {
        next.locked = remove(next.locked, key);
        next.privileged = remove(next.privileged, key); // unlock revokes privilege
      }
      break;
    case "privilege":
      if (value) {
        next.privileged = add(next.privileged, key);
        next.locked = add(next.locked, key); // privilege implies lock
      } else {
        next.privileged = remove(next.privileged, key); // lock stays
      }
      break;
  }

  persist(workspaceId, next);
  return next;
}

/** Drop a path from all lists — call when the file is deleted so no stale protection lingers. */
export function removePath(workspaceId: string, relPath: string): void {
  const key = normalizePermPath(relPath);
  if (key === null) return;
  const prev = getPermissions(workspaceId);
  if (!prev.locked.includes(key) && !prev.hidden.includes(key) && !prev.privileged.includes(key)) return;
  persist(workspaceId, {
    locked: remove(prev.locked, key),
    hidden: remove(prev.hidden, key),
    privileged: remove(prev.privileged, key),
  });
}

export const isLocked = (workspaceId: string, relPath: string): boolean =>
  getPermissions(workspaceId).locked.includes(normalizePermPath(relPath) ?? relPath);
export const isHidden = (workspaceId: string, relPath: string): boolean =>
  getPermissions(workspaceId).hidden.includes(normalizePermPath(relPath) ?? relPath);
export const isPrivileged = (workspaceId: string, relPath: string): boolean =>
  getPermissions(workspaceId).privileged.includes(normalizePermPath(relPath) ?? relPath);

/** Test-only: drop the in-memory cache so a fresh read hits disk. */
export function _resetPermissionCache(): void {
  cache.clear();
}

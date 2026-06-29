// Impure companion to agentPermissions.ts (the pure policy core): loads/saves the per-workspace
// permission store and composes the real `docker run` restriction args against the host filesystem.
//
// Layout (all host-side, OUTSIDE the /workspace mount so the agent can never reach it):
//   <WORKSPACES_ROOT>/.agent-permissions/<workspaceId>.json        <- the store
//   <WORKSPACES_ROOT>/.agent-permissions/<workspaceId>/stubs/...    <- deny-read stub assets
//
// The store JSON is the source of truth; composeAgentMounts turns it into the extra mount args the
// container is (re)created with. Fail-closed throughout: a corrupt store or an unresolvable path
// THROWS (PolicyError) so the caller refuses to start the container, never falls back to a
// read-write passthrough — the failure mode that sank the prior drafts.

import fs from "fs";
import crypto from "crypto";
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { createLogger } from "../logger";
import {
  buildRestrictionMounts,
  EMPTY_PERMISSIONS,
  PolicyError,
  type AgentPermissions,
  type PolicyProbes,
} from "./agentPermissions";

const log = createLogger("agentPerms");

const STORE_DIR = path.join(WORKSPACES_ROOT, ".agent-permissions");

export function permissionsPath(workspaceId: string): string {
  return path.join(STORE_DIR, `${workspaceId}.json`);
}

function stubRoot(workspaceId: string): string {
  return path.join(STORE_DIR, workspaceId, "stubs");
}

/** Load a workspace's permissions. Missing file → empty (no restrictions). A present-but-unparseable
 *  file THROWS so the container build fails closed rather than running unrestricted on a corrupt store. */
export function loadPermissions(workspaceId: string): AgentPermissions {
  let raw: string;
  try {
    raw = fs.readFileSync(permissionsPath(workspaceId), "utf-8");
  } catch {
    return EMPTY_PERMISSIONS; // no store yet = nothing restricted
  }
  let parsed: Partial<AgentPermissions>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PolicyError(`permission store for ${workspaceId} is unparseable: ${String(err)}`);
  }
  return {
    denyRead: parsed.denyRead ?? [],
    denyEdit: parsed.denyEdit ?? [],
    privilegedScripts: parsed.privilegedScripts ?? [],
  };
}

export function savePermissions(workspaceId: string, perms: AgentPermissions): void {
  const file = permissionsPath(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(perms, null, 2));
  fs.renameSync(tmp, file);
}

function hasRestrictions(p: AgentPermissions): boolean {
  return p.denyRead.length > 0 || p.denyEdit.length > 0;
}

/** True if `rel` or any ancestor directory is in `set` — so a folder restriction also covers the
 *  files nested under it (the mount masks the whole subtree). */
function underAny(set: Set<string>, rel: string): boolean {
  let cur = rel;
  for (;;) {
    if (set.has(cur)) return true;
    const parent = path.posix.dirname(cur);
    if (parent === cur || parent === ".") return false;
    cur = parent;
  }
}

/** A defense-in-depth predicate pair for the file tools: clean agent-facing errors that mirror what
 *  the mount topology already enforces in the kernel. NOT the security boundary (a raw shell still
 *  hits the kernel mount); just nicer messages than a stub line or a bare EROFS. */
export interface FilePolicy {
  isDenyRead(rel: string): boolean;
  isDenyEdit(rel: string): boolean;
  /** True if `rel` is a privileged script OR sits under a privileged folder — privilege keyed on a
   *  folder trickles down to every script beneath it (matching the deny-read/deny-edit subtree rule). */
  isPrivileged(rel: string): boolean;
}

export const ALLOW_ALL_POLICY: FilePolicy = {
  isDenyRead: () => false,
  isDenyEdit: () => false,
  isPrivileged: () => false,
};

/** Build the file-tool policy from a workspace's store. A corrupt store yields allow-all here (the
 *  container build is where it fails closed); the tools are only a UX backstop. */
export function buildFilePolicy(workspaceId: string): FilePolicy {
  let p: AgentPermissions;
  try {
    p = loadPermissions(workspaceId);
  } catch {
    return ALLOW_ALL_POLICY;
  }
  const denyRead = new Set(p.denyRead);
  const denyEdit = new Set(p.denyEdit);
  const privileged = new Set(p.privilegedScripts);
  return {
    isDenyRead: (rel) => underAny(denyRead, rel),
    // A deny-read path is a read-only stub mount too, so it is also non-writable.
    isDenyEdit: (rel) => underAny(denyEdit, rel) || underAny(denyRead, rel),
    isPrivileged: (rel) => underAny(privileged, rel),
  };
}

/** True if the workspace has at least one registered privileged script (gates the broker tool).
 *  Safe on a corrupt store (returns false). */
export function hasPrivilegedScripts(workspaceId: string): boolean {
  try {
    return loadPermissions(workspaceId).privilegedScripts.length > 0;
  } catch {
    return false;
  }
}

/** Remove a workspace's permission store and its stub assets. Called on workspace deletion. */
export function deletePermissions(workspaceId: string): void {
  fs.rmSync(permissionsPath(workspaceId), { force: true });
  fs.rmSync(path.join(STORE_DIR, workspaceId), { recursive: true, force: true });
}

/** A stable fingerprint of the MOUNT-AFFECTING policy (deny-read + deny-edit only — privileged
 *  scripts don't change the topology). Stamped on the container as a label so `ensure` can detect
 *  a flip and recreate exactly once when it changes. "none" when nothing is restricted. */
export function mountPolicyHash(workspaceId: string): string {
  const p = loadPermissions(workspaceId);
  if (!hasRestrictions(p)) return "none";
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ denyRead: [...p.denyRead].sort(), denyEdit: [...p.denyEdit].sort() }))
    .digest("hex")
    .slice(0, 16);
}

/** The three lists a path can be added to/removed from via the UI. */
export type PermList = "denyRead" | "denyEdit" | "privilegedScripts";
const PERM_LISTS: readonly PermList[] = ["denyRead", "denyEdit", "privilegedScripts"];

function isSafeRelpath(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const norm = path.normalize(rel);
  return norm !== "." && !norm.startsWith("..") && !norm.split(path.sep).includes("..");
}

/** Add or remove a workspace-relative path from one of the permission lists, persist, and return
 *  the updated store. Idempotent (Set-backed). Rejects an unsafe relpath or unknown list.
 *
 *  Enforces the privilege⟺lock invariant: a privileged script runs UNRESTRICTED through the broker,
 *  so if the agent could edit it, it could rewrite the script and then trigger it to escape every
 *  restriction. Therefore granting privilege auto-locks the script (adds deny-edit), and unlocking a
 *  path (removing deny-edit) auto-revokes any privilege on it. The two are kept consistent here, the
 *  single write path, so the store can never persist a privileged-but-editable script. */
export function setPermission(
  workspaceId: string,
  list: PermList,
  relPath: string,
  on: boolean,
): AgentPermissions {
  if (!PERM_LISTS.includes(list)) throw new PolicyError(`unknown permission list: ${JSON.stringify(list)}`);
  if (!isSafeRelpath(relPath)) throw new PolicyError(`unsafe path: ${JSON.stringify(relPath)}`);
  const perms = loadPermissions(workspaceId);
  const sets: Record<PermList, Set<string>> = {
    denyRead: new Set(perms.denyRead),
    denyEdit: new Set(perms.denyEdit),
    privilegedScripts: new Set(perms.privilegedScripts),
  };

  if (on) sets[list].add(relPath);
  else sets[list].delete(relPath);

  // Privilege requires lock: a privileged script the agent could edit is a sandbox escape.
  if (list === "privilegedScripts" && on) sets.denyEdit.add(relPath);
  // Unlocking makes the path agent-editable, which would re-open that escape — so revoke privilege.
  if (list === "denyEdit" && !on) sets.privilegedScripts.delete(relPath);

  const next: AgentPermissions = {
    denyRead: [...sets.denyRead].sort(),
    denyEdit: [...sets.denyEdit].sort(),
    privilegedScripts: [...sets.privilegedScripts].sort(),
  };
  savePermissions(workspaceId, next);
  return next;
}

/** Host filesystem probes for the pure policy core. statSync follows symlinks (so a symlinked path
 *  resolves through the mount, as intended); nlink is the real file's hard-link count. */
function realProbes(workspaceDir: string): PolicyProbes {
  return {
    statKind: (rel) => {
      try {
        return fs.statSync(path.join(workspaceDir, rel)).isDirectory() ? "dir" : "file";
      } catch {
        return "missing";
      }
    },
    nlinkOf: (rel) => {
      try {
        return fs.statSync(path.join(workspaceDir, rel)).nlink;
      } catch {
        return 0;
      }
    },
  };
}

/**
 * Compose the extra `docker run` args that enforce this workspace's permissions, materializing any
 * deny-read stub assets on the host first. Returns [] when nothing is restricted.
 *
 * @param isVolumeMounted true when the base mount is a Docker named volume (production). The mount
 *   sources here are app-container paths the daemon cannot see in that mode, so restrictions are not
 *   yet supported there — we throw rather than emit mounts that would silently fail to protect.
 * @throws PolicyError on a corrupt store, an unresolvable path, or volume-mode-with-restrictions.
 */
export function composeAgentMounts(
  workspaceId: string,
  workspaceDir: string,
  isVolumeMounted: boolean,
): string[] {
  const perms = loadPermissions(workspaceId);
  if (!hasRestrictions(perms)) return [];

  if (isVolumeMounted) {
    // Fail closed: never run with restrictions configured but unenforced. Volume-subpath translation
    // is the next slice (see ADR rename-brittleness / topology notes).
    throw new PolicyError(
      `agent file restrictions are set for ${workspaceId} but the volume-mount topology (WORKSPACES_VOLUME_NAME) does not yet support them — refusing to start unrestricted`,
    );
  }

  const { args, stubs } = buildRestrictionMounts(
    workspaceDir,
    stubRoot(workspaceId),
    perms,
    realProbes(workspaceDir),
  );

  for (const stub of stubs) {
    fs.mkdirSync(path.dirname(stub.hostPath), { recursive: true });
    fs.writeFileSync(stub.hostPath, stub.content);
  }

  log.debug({ workspaceId, mountCount: args.length / 2 }, "composed agent restriction mounts");
  return args;
}

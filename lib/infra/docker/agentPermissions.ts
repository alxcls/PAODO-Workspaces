// Agent file-restriction policy core (see doc/adr/draft/adr-agent-filesystem-restrictions-via-mount-topology.md).
//
// The permission store is the source of truth; the agent container's MOUNT TOPOLOGY is the
// enforcement — composed here into extra `docker run` args. Nothing about this is a tool-level
// check: the args produced here are handed to `docker run`, so a uid-1000 shell inside the
// container cannot undo them (changing mounts needs CAP_SYS_ADMIN, which is dropped).
//
// This module is deliberately PURE: it takes the resolved store plus injected `statKind`/`nlinkOf`
// probes and returns the args + the stub assets the caller must materialize on the host BEFORE
// `docker run`. That keeps the policy decisions unit-testable without Docker or a real filesystem,
// and keeps the fail-closed rule (throw, never silently pass a path through read-write) honest.

import path from "path";

export interface AgentPermissions {
  /** Workspace-relative paths whose CONTENT is withheld (name stays visible). */
  denyRead: string[];
  /** Workspace-relative paths the agent may read but not write/replace/delete. */
  denyEdit: string[];
  /** Workspace-relative registered script paths the agent may trigger via the broker. */
  privilegedScripts: string[];
}

export const EMPTY_PERMISSIONS: AgentPermissions = {
  denyRead: [],
  denyEdit: [],
  privilegedScripts: [],
};

/** One file the caller must write to the host (outside any workspace mount) before `docker run`. */
export interface StubAsset {
  /** Absolute host path to create. */
  hostPath: string;
  /** UTF-8 content to write. */
  content: string;
}

export interface RestrictionMounts {
  /** Extra args to splice into the `docker run` argv, after the base `-v …:/workspace`. */
  args: string[];
  /** Stub files/dirs to materialize host-side before the run (deny-read targets bind to these). */
  stubs: StubAsset[];
}

/** Filesystem kind of a workspace-relative path, as probed on the host volume. */
export type PathKind = "file" | "dir" | "missing";

export interface PolicyProbes {
  /** Kind of `relpath` on the host workspace volume. */
  statKind: (relpath: string) => PathKind;
  /** Hard-link count of `relpath` (st_nlink). Only consulted for deny-read FILES. */
  nlinkOf: (relpath: string) => number;
}

const STUB_FILE_BODY = "[restricted: content withheld by workspace policy]\n";
const STUB_DIR_README = "This folder is restricted by workspace policy.\n";

/** Reject paths that could escape the workspace or collide with the mount root. */
function assertSafeRelpath(rel: string): void {
  if (!rel || path.isAbsolute(rel)) throw new PolicyError(`path must be workspace-relative: ${JSON.stringify(rel)}`);
  const norm = path.normalize(rel);
  if (norm === "." || norm.startsWith("..") || norm.split(path.sep).includes("..")) {
    throw new PolicyError(`path escapes the workspace: ${JSON.stringify(rel)}`);
  }
}

/** Thrown on any unresolved/ambiguous policy input. The caller MUST fail closed (refuse to start
 *  the container) rather than fall back to a read-write passthrough — the bug the prior drafts had. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Host-side stub path for a deny-read target, encoded uniquely+reversibly from the relpath
 *  (encodeURIComponent turns `/` into %2F, so distinct paths never collide and stay valid names). */
function stubPathFor(stubRoot: string, kind: "read" | "readdir", rel: string): string {
  return path.join(stubRoot, kind, encodeURIComponent(rel));
}

/** True if `rel` or any ancestor directory is in `set` — so a deny-read FOLDER also covers files
 *  nested under it (its stub-dir mount already masks the whole subtree). */
function coveredBy(set: Set<string>, rel: string): boolean {
  let cur = path.normalize(rel);
  for (;;) {
    if (set.has(cur)) return true;
    const parent = path.dirname(cur);
    if (parent === cur || parent === ".") return false;
    cur = parent;
  }
}

/**
 * Compose the restriction mounts for one workspace from its permission store.
 *
 * @param workspaceDir absolute host path of the workspace (the `:/workspace` source).
 * @param stubRoot     absolute host dir, OUTSIDE any workspace mount, to hold deny-read stubs.
 * @param perms        the resolved permission store.
 * @param probes       host filesystem probes (statKind / nlinkOf).
 * @throws PolicyError on any missing path, unsafe path, or multi-linked deny-read file — caller
 *         must fail closed.
 */
export function buildRestrictionMounts(
  workspaceDir: string,
  stubRoot: string,
  perms: AgentPermissions,
  probes: PolicyProbes,
): RestrictionMounts {
  const args: string[] = [];
  const stubs: StubAsset[] = [];
  const denyReadSet = new Set(perms.denyRead.map((r) => path.normalize(r)));

  // Deny-read: bind a read-only stub OVER the path so the name survives `ls` but reads hit the stub.
  for (const rel of perms.denyRead) {
    assertSafeRelpath(rel);
    const kind = probes.statKind(rel);
    const target = `/workspace/${rel}`;
    if (kind === "file") {
      // Per-path mounts are path-based, not inode-based: a hardlink to the same inode at another
      // path would still read the real bytes (spike-confirmed leak). Refuse rather than leak.
      if (probes.nlinkOf(rel) > 1) {
        throw new PolicyError(
          `deny-read file ${JSON.stringify(rel)} has st_nlink>1; a per-path mount cannot mask its other hardlinks. Copy-break the file first.`,
        );
      }
      const stub = stubPathFor(stubRoot, "read", rel);
      stubs.push({ hostPath: stub, content: STUB_FILE_BODY });
      args.push("-v", `${stub}:${target}:ro`);
    } else if (kind === "dir") {
      // Read-only bind of a stub dir (README only): real entries vanish, README explains. Chosen
      // over a ro tmpfs, which cannot be pre-seeded with the README (spike-confirmed).
      const stubDir = stubPathFor(stubRoot, "readdir", rel);
      stubs.push({ hostPath: path.join(stubDir, "README"), content: STUB_DIR_README });
      args.push("-v", `${stubDir}:${target}:ro`);
    } else {
      throw new PolicyError(`deny-read path ${JSON.stringify(rel)} does not exist on the workspace volume`);
    }
  }

  // Deny-edit: bind the REAL path :ro as its own mountpoint over the RW base. Two kernel guarantees:
  // writes return EROFS, and `rm`/`mv` from the writable parent return EBUSY (it is a mountpoint).
  for (const rel of perms.denyEdit) {
    assertSafeRelpath(rel);
    // Deny-read is strictly stronger and already mounts this path (or a parent) read-only. Emitting a
    // second mount at the same target makes `docker run` fail with "Duplicate mount point"; skip it.
    if (coveredBy(denyReadSet, rel)) continue;
    const kind = probes.statKind(rel);
    if (kind === "missing") {
      throw new PolicyError(`deny-edit path ${JSON.stringify(rel)} does not exist on the workspace volume`);
    }
    const source = path.join(workspaceDir, rel);
    args.push("-v", `${source}:/workspace/${rel}:ro`);
  }

  return { args, stubs };
}

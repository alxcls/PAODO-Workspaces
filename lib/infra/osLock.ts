// OS-level permission enforcement for the three-identity model (Eye / Lock / Key).
// runRoot — runs a command as root inside the container (for chown/chmod).
// reconcileOsPermissions — aligns actual file ownership+mode with the permission store state.
// reconcileKeyedExecutable — chmod +x keyed scripts so privd dispatch works after key toggles.
//
// Ownership/mode scheme:
//   Normal:        uid 999  : gid 1001, file=664 / dir=3775 (sticky — agent can't delete privd-owned files)
//   Eye-off:       uid 1002 : gid 1001, file=662 / dir=3773 (agent keeps -w- but no read bit)
//   Lock:          uid 998  : gid 1001, file=644 / dir=755
//   Eye-off+Lock:  uid 998  : gid 1001, file=640 / dir=750
//   Keyed:         uid 998  : gid 1001, file=755 / dir=755  (privd-owned; agent has r-x, cannot write)
//   Keyed+Eye-off: uid 998  : gid 1001, file=750 / dir=750
import { dockerExec, ensureContainer, applyKeyedExecutable, type DockerResult } from "./containerManager";
import {
  readPermissionSnapshot,
  isHiddenFromSnapshot,
  isLockedFromSnapshot,
  isKeyedFromSnapshot,
} from "./permissionStore";
import { getWorkspace } from "./workspaceStore";
import { createLogger } from "./logger";

const log = createLogger("osLock");

type PermissionSnapshot = Awaited<ReturnType<typeof readPermissionSnapshot>>;

// Runs cmdArgs as root (container default user — no USER set in Dockerfile) inside the workspace container.
export async function runRoot(workspaceId: string, cmdArgs: string[]): Promise<DockerResult> {
  const ws = getWorkspace(workspaceId);
  if (!ws) return { stdout: "", stderr: `workspace ${workspaceId} not found`, code: 1 };
  // No asAgent flag → runs as the container's default user (root).
  return dockerExec(workspaceId, ws.dir, cmdArgs);
}

// Ensures keyed scripts are chmod +x after a key toggle or full permission sweep.
// Ensures the container is running first so the chmod succeeds even when called on an idle workspace.
export async function reconcileKeyedExecutable(workspaceId: string): Promise<void> {
  const ws = getWorkspace(workspaceId);
  if (!ws) return;
  await ensureContainer(workspaceId, ws.dir);
  await applyKeyedExecutable(workspaceId);
}

// --- OS permission reconciliation ---

interface ModeSpec {
  uid: number;
  gid: number;
  fileMode: string;
  dirMode: string;
}

function resolveMode(isHidden: boolean, isLocked: boolean, isKeyed: boolean): ModeSpec {
  if (isKeyed && isHidden) return { uid: 998, gid: 1001, fileMode: "750", dirMode: "750" };
  if (isKeyed)             return { uid: 998, gid: 1001, fileMode: "755", dirMode: "755" };
  if (isHidden && isLocked) return { uid: 998, gid: 1001, fileMode: "640", dirMode: "750" };
  if (isLocked)             return { uid: 998, gid: 1001, fileMode: "644", dirMode: "755" };
  if (isHidden)             return { uid: 1002, gid: 1001, fileMode: "662", dirMode: "3773" };
  return                           { uid: 999,  gid: 1001, fileMode: "664", dirMode: "3775" };
}

function gatherDirectoriesToFix(relPaths: string[]): string[] {
  const dirs = new Set<string>();
  for (const relPath of relPaths) {
    if (!relPath || relPath === ".") continue;
    const segments = relPath.split("/");
    for (let i = 1; i < segments.length; i++) {
      dirs.add(segments.slice(0, i).join("/"));
    }
  }
  dirs.add(".");
  return Array.from(dirs).sort((a, b) => a.split("/").length - b.split("/").length);
}

function hasPrivilegedDescendant(snapshot: PermissionSnapshot, relPath: string): boolean {
  const prefixes = [snapshot.locked, snapshot.keyed];
  const target = relPath === "." ? "" : `${relPath}/`;
  return prefixes.some((paths) =>
    paths.some((p) => p === relPath || (target !== "" ? p.startsWith(target) : p.length > 0)),
  );
}

async function applyDirectoryMode(
  workspaceId: string,
  relPath: string,
  snapshot: PermissionSnapshot,
): Promise<void> {
  const isHidden = isHiddenFromSnapshot(snapshot, relPath);
  const isLocked = isLockedFromSnapshot(snapshot, relPath);
  const isKeyed = isKeyedFromSnapshot(snapshot, relPath);
  let { uid, gid, dirMode } = resolveMode(isHidden, isLocked, isKeyed);

  const hasTopLevelPrivileged = snapshot.locked.concat(snapshot.keyed).some((p) => p && !p.includes("/"));
  const shouldGuardRoot = relPath === "." && (snapshot.globalLock || hasTopLevelPrivileged);

  if (shouldGuardRoot) {
    uid = 998;
    gid = 1001;
    dirMode = snapshot.globalLock ? "3775" : "3777";
  } else if (
    relPath !== "." &&
    !isHidden &&
    !isLocked &&
    !isKeyed &&
    hasPrivilegedDescendant(snapshot, relPath)
  ) {
    uid = 998;
    gid = 1001;
    dirMode = "3775";
  }

  const containerPath = relPath === "." ? "/workspace" : `/workspace/${relPath}`;
  await runRoot(workspaceId, ["chmod", dirMode, containerPath]);
  await runRoot(workspaceId, ["chown", `${uid}:${gid}`, containerPath]);
}

// Applies correct ownership and mode to a single path (and recursively to its subtree).
async function applyMode(workspaceId: string, relPath: string, isHidden: boolean, isLocked: boolean, isKeyed: boolean): Promise<void> {
  const { uid, gid, fileMode, dirMode } = resolveMode(isHidden, isLocked, isKeyed);
  const containerPath = relPath === "." ? "/workspace" : `/workspace/${relPath}`;

  // chmod files first (while still under current ownership), then chown
  await runRoot(workspaceId, ["find", containerPath, "-type", "f", "-exec", "chmod", fileMode, "{}", "+"]);
  await runRoot(workspaceId, ["find", containerPath, "-type", "d", "-exec", "chmod", dirMode, "{}", "+"]);
  await runRoot(workspaceId, ["find", containerPath, "-exec", "chown", `${uid}:${gid}`, "{}", "+"]);
}

// Reconciles actual container file ownership/mode with the current permission store state.
//
// relPath (optional): targeted reconcile for a specific path after a toggle.
//   Omit for a full-workspace sweep (e.g. after apt install, to fix root-owned artifacts).
export async function reconcileOsPermissions(workspaceId: string, relPath?: string): Promise<void> {
  try {
    const ws = getWorkspace(workspaceId);
    if (!ws) return;

    const snapshot = await readPermissionSnapshot(workspaceId);

    if (relPath) {
      // Targeted: reconcile only this path (and its subtree if it's a directory).
      await applyMode(
        workspaceId,
        relPath,
        isHiddenFromSnapshot(snapshot, relPath),
        isLockedFromSnapshot(snapshot, relPath),
        isKeyedFromSnapshot(snapshot, relPath),
      );

      const dirsToFix = gatherDirectoriesToFix([relPath]);
      for (const dir of dirsToFix) {
        await applyDirectoryMode(workspaceId, dir, snapshot);
      }

      // applyMode issues a literal chmod NNN which strips +x. Re-apply it for any keyed scripts.
      await reconcileKeyedExecutable(workspaceId);
      return;
    }

    // Full sweep — used after apt installs to fix root-owned artifacts.
    // 1. Fix mode bits on any root-owned files before changing ownership.
    await runRoot(workspaceId, ["find", "/workspace", "-user", "root", "-type", "f", "-exec", "chmod", "664", "{}", "+"]);
    await runRoot(workspaceId, ["find", "/workspace", "-user", "root", "-type", "d", "-exec", "chmod", "2775", "{}", "+"]);
    // 2. Chown any remaining root-owned files to Normal state (uid 999).
    await runRoot(workspaceId, ["find", "/workspace", "-user", "root", "-exec", "chown", "999:1001", "{}", "+"]);

    // 3. Normalize any paths that still carry hidden/locked/keyed ownership but are no longer
    // configured in the permission store. This closes drift where the JSON store was updated
    // successfully (e.g. hidden/locked cleared) but a prior OS reconcile failed.
    const configured = new Set<string>([...snapshot.locked, ...snapshot.hidden, ...snapshot.keyed]);
    const isUnderConfigured = (p: string): boolean => {
      if (!p || p === ".") return false;
      for (const base of configured) {
        if (!base) continue;
        if (p === base || p.startsWith(base + "/")) return true;
      }
      return false;
    };

    const orphanScan = await runRoot(workspaceId, [
      "find", "/workspace",
      "-xdev",
      "-uid", "998", "-o", "-uid", "1002",
      "-printf", "%P\n",
    ]);
    if (orphanScan.code === 0 && orphanScan.stdout) {
      const orphanRelPaths = orphanScan.stdout.split("\n").filter(Boolean);
      for (const rel of orphanRelPaths) {
        if (isUnderConfigured(rel)) continue;
        // Reset to Normal state for any path that is no longer configured but still carries
        // privd/appuser ownership from a previous permission setting.
        await applyMode(workspaceId, rel, false, false, false);
      }
    }

    // 4. Re-apply configured paths (shallower first so deeper paths override parent-level settings).
    const allConfigured = [...new Set([...snapshot.locked, ...snapshot.hidden, ...snapshot.keyed])]
      .sort((a, b) => a.split("/").length - b.split("/").length);
    for (const p of allConfigured) {
      await applyMode(
        workspaceId,
        p,
        isHiddenFromSnapshot(snapshot, p),
        isLockedFromSnapshot(snapshot, p),
        isKeyedFromSnapshot(snapshot, p),
      );
    }

    const dirsToFix = gatherDirectoriesToFix(allConfigured);
    for (const dir of dirsToFix) {
      await applyDirectoryMode(workspaceId, dir, snapshot);
    }

    // 5. Ensure keyed scripts are executable.
    await reconcileKeyedExecutable(workspaceId);
  } catch (err) {
    log.warn({ err, workspaceId, relPath }, "reconcileOsPermissions failed — software checks still enforce");
  }
}

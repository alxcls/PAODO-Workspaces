// OS-level permission enforcement for the three-identity model (Eye / Lock / Key).
// runRoot — runs a command as root inside the container (for chown/chmod).
// reconcileOsPermissions — aligns actual file ownership+mode with the permission store state.
// reconcileKeyedSudoers — writes /etc/sudoers.d/keyed-scripts so agent can run keyed scripts as privd.
//
// Ownership/mode scheme (ADR §2):
//   Normal:        uid 999 : gid 1001,  file=664 / dir=2775
//   Eye-off:       uid 1002 : gid 1001, file=660 / dir=2770
//   Lock:          uid 998  : gid 1001, file=644 / dir=755
//   Eye-off+Lock:  uid 998  : gid 1001, file=640 / dir=750
import { dockerExec, ensureContainer, applyKeyedSudoers, type DockerResult } from "./containerManager";
import {
  readPermissionSnapshot,
  isHiddenFromSnapshot,
  isLockedFromSnapshot,
} from "./permissionStore";
import { getWorkspace } from "./workspaceStore";
import { createLogger } from "./logger";

const log = createLogger("osLock");

// Runs cmdArgs as root (container default user — no USER set in Dockerfile) inside the workspace container.
export async function runRoot(workspaceId: string, cmdArgs: string[]): Promise<DockerResult> {
  const ws = getWorkspace(workspaceId);
  if (!ws) return { stdout: "", stderr: `workspace ${workspaceId} not found`, code: 1 };
  // No asAgent flag → runs as the container's default user (root).
  return dockerExec(workspaceId, ws.dir, cmdArgs);
}

// Regenerates /etc/sudoers.d/keyed-scripts after a key toggle or full permission sweep.
// Ensures the container is running first so the write succeeds even when called on an idle workspace.
// Delegates the actual write to applyKeyedSudoers (raw dockerCmd) which is safe to call both here
// and during _ensureContainer without deadlocking on startLocks.
export async function reconcileKeyedSudoers(workspaceId: string): Promise<void> {
  const ws = getWorkspace(workspaceId);
  if (!ws) return;
  await ensureContainer(workspaceId, ws.dir);
  await applyKeyedSudoers(workspaceId);
}

// --- OS permission reconciliation ---

interface ModeSpec {
  uid: number;
  gid: number;
  fileMode: string;
  dirMode: string;
}

function resolveMode(isHidden: boolean, isLocked: boolean): ModeSpec {
  if (isHidden && isLocked) return { uid: 998, gid: 1001, fileMode: "640", dirMode: "750" };
  if (isLocked)             return { uid: 998, gid: 1001, fileMode: "644", dirMode: "755" };
  if (isHidden)             return { uid: 1002, gid: 1001, fileMode: "660", dirMode: "2770" };
  return                           { uid: 999,  gid: 1001, fileMode: "664", dirMode: "2775" };
}

// Applies correct ownership and mode to a single path (and recursively to its subtree).
async function applyMode(workspaceId: string, relPath: string, isHidden: boolean, isLocked: boolean): Promise<void> {
  const { uid, gid, fileMode, dirMode } = resolveMode(isHidden, isLocked);
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
      );
      return;
    }

    // Full sweep — used after apt installs to fix root-owned artifacts.
    // 1. Fix mode bits on any root-owned files before changing ownership.
    await runRoot(workspaceId, ["find", "/workspace", "-user", "root", "-type", "f", "-exec", "chmod", "664", "{}", "+"]);
    await runRoot(workspaceId, ["find", "/workspace", "-user", "root", "-type", "d", "-exec", "chmod", "2775", "{}", "+"]);
    // 2. Chown any remaining root-owned files to Normal state (uid 999).
    await runRoot(workspaceId, ["find", "/workspace", "-user", "root", "-exec", "chown", "999:1001", "{}", "+"]);

    // 3. Re-apply configured paths (shallower first so deeper paths override parent-level settings).
    const allConfigured = [...new Set([...snapshot.locked, ...snapshot.hidden])]
      .sort((a, b) => a.split("/").length - b.split("/").length);
    for (const p of allConfigured) {
      await applyMode(
        workspaceId,
        p,
        isHiddenFromSnapshot(snapshot, p),
        isLockedFromSnapshot(snapshot, p),
      );
    }

    // 4. Sync sudoers for keyed scripts.
    await reconcileKeyedSudoers(workspaceId);
  } catch (err) {
    log.warn({ err, workspaceId, relPath }, "reconcileOsPermissions failed — software checks still enforce");
  }
}

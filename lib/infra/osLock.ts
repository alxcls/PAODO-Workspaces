// OS-level enforcement of file locks and privileged-script protection inside a workspace container.
//
// The agent's `execute_command` runs as the non-root `developer` user, so the kernel — not the
// system prompt — is what actually stops it from writing locked files or reading hidden secrets.
// This module owns the privileged side of that boundary: it runs `docker exec -u root` to set
// ownership/mode bits so that:
//   - LOCKED paths   → root:root, write bit cleared (a-w) → files 0444, dirs 0555. `developer`
//                      cannot write or delete them, even via a script it writes.
//   - UNLOCKED files → developer:developer 0644.
//   - DIRECTORIES    → root:developer 01775 (sticky + group-write). `developer` is in the
//                      `developer` group, so it can create files and delete its OWN files, but the
//                      sticky bit prevents it from deleting root-owned (locked/hidden) entries.
//
// Root ownership is the durable signal for "protected": manually-locked paths are chowned to root
// so `reconcileOsPermissions` never demotes them back to developer on restart.
//
// It deliberately does NOT import containerManager: `reconcileOsPermissions` is invoked from
// inside `_ensureContainer`, so going through `dockerExec` (which calls `ensureContainer`) would
// deadlock on the start-lock. Instead it spawns `docker exec` directly. Callers that run OUTSIDE
// container creation (the permissions route) must `ensureContainer` themselves first.
//
// ENFORCEMENT MODEL — depends on the mount type:
//   - Production (Linux host, bind mount or named volume): a real Linux filesystem. `chown`,
//     `chmod`, and the sticky bit are fully enforced by the kernel — developer cannot write or
//     delete a root-owned file, even via a script it writes itself.
//   - Local macOS dev (Docker Desktop with VirtioFS, default since Desktop 4.6): VirtioFS runs
//     inside a Linux VM so the kernel DOES enforce chown/chmod/sticky. Locks are fully effective.
//   - Legacy macOS dev (Docker Desktop with gRPC-FUSE): mode bits and ownership are NOT enforced
//     for writes; writes from inside the container pass straight through. Locks are advisory in
//     that configuration — they block the tool-layer checks (file_write/file_edit) but not raw
//     shell writes from scripts. Secret hiding is unaffected (process-env + UID separation).
//     The chown/chmod calls are kept because they are correct on VirtioFS and production; they
//     are cosmetic on the legacy gRPC-FUSE mount only.
import path from "path";
import { spawn } from "child_process";
import { readPermissionSnapshot } from "./permissionStore";
import { listPrivileged } from "./privilegeStore";
import { listHidden } from "./hiddenStore";
import { createLogger } from "./logger";

const log = createLogger("osLock");

const DEVELOPER = "developer:developer";

// GID the app server (the file-tree viewer, host-side) runs as. HIDDEN paths are chowned to
// root:APP_GID 0640 so root (privileged scripts) and the app (user viewing) can read, but `developer`
// (the agent, UID 1001, NOT in this group) lands in "other" and cannot read. Default 1000 = the
// `node` user/group in the app image and the base-image `ubuntu` group in the workspace container.
const APP_GID = process.env.APP_GID ?? "1000";

function containerName(workspaceId: string): string {
  return `ws_${workspaceId}`;
}

// Runs a command as root inside the (already-running) workspace container. Does NOT ensure the
// container exists — callers must guarantee that (reconcile runs right after start; the route
// calls ensureContainer first). cmdArgs go straight to execvp — no shell, so no injection.
function runRoot(workspaceId: string, cmdArgs: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("docker", ["exec", "-u", "root", "-w", "/workspace", containerName(workspaceId), ...cmdArgs]);
    } catch (err) {
      resolve({ stdout: "", stderr: (err as Error).message, code: 1 });
      return;
    }
    proc.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.stdout!.on("error", () => {});
    proc.stderr!.on("error", () => {});
    proc.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
    proc.stdin!.end();
  });
}

// Makes a path (file or directory subtree) root-owned and unwritable by `developer`.
// `a-w` clears the write bit for all → 0444 files / 0555 dirs; root still owns it and the server
// can rewrite it. Also fixes the parent directory to root:developer 01775 (sticky) so that
// `developer` cannot `rm` the now-root-owned target even though it can write to the parent.
// Idempotent.
async function lockOnDisk(workspaceId: string, relPath: string): Promise<void> {
  const target = `/workspace/${relPath}`;
  const [r1, r2] = await Promise.all([
    runRoot(workspaceId, ["chown", "-R", "root:root", target]),
    runRoot(workspaceId, ["chmod", "-R", "a-w", target]),
  ]);
  if (r1.code !== 0 || r2.code !== 0) {
    log.warn({ workspaceId, relPath, chown: r1.stderr, chmod: r2.stderr }, "lockOnDisk failed");
  }
  const parentDir = path.posix.dirname(target);
  if (parentDir !== "/") {
    await Promise.all([
      runRoot(workspaceId, ["chown", "root:developer", parentDir]),
      runRoot(workspaceId, ["chmod", "01775", parentDir]),
    ]);
  }
}

// Returns a path to the unlocked state: files → developer:developer 0644, dirs → root:developer
// 01775 (sticky + group-write). Handles both single-file and directory targets via `find` so the
// file/directory treatment is consistent whether relPath is a leaf or a subtree root.
async function unlockOnDisk(workspaceId: string, relPath: string): Promise<void> {
  const target = `/workspace/${relPath}`;
  const [r1, r2, r3, r4] = await Promise.all([
    runRoot(workspaceId, ["find", target, "(", "-type", "f", "-o", "-type", "l", ")", "-exec", "chown", DEVELOPER, "{}", "+"]),
    runRoot(workspaceId, ["find", target, "(", "-type", "f", "-o", "-type", "l", ")", "-exec", "chmod", "u+w", "{}", "+"]),
    runRoot(workspaceId, ["find", target, "-type", "d", "-exec", "chown", "root:developer", "{}", "+"]),
    runRoot(workspaceId, ["find", target, "-type", "d", "-exec", "chmod", "01775", "{}", "+"]),
  ]);
  if (r1.code !== 0 || r2.code !== 0 || r3.code !== 0 || r4.code !== 0) {
    log.warn({ workspaceId, relPath, r1: r1.stderr, r2: r2.stderr, r3: r3.stderr, r4: r4.stderr }, "unlockOnDisk failed");
  }
}

// Makes a path root-owned and readable only by root + the app group (APP_GID) — never by
// `developer`. Files → 0640, dirs → 0755 (so the agent can still list names but not read contents;
// names visible, contents hidden). The app server (in APP_GID) reads via the group bit for the
// user-facing viewer; root reads for privileged scripts. Also fixes the parent to root:developer 01775
// (sticky) so developer cannot `rm` the hidden entry. Idempotent.
async function hideOnDisk(workspaceId: string, relPath: string): Promise<void> {
  const target = `/workspace/${relPath}`;
  const [r1, r2, r3] = await Promise.all([
    runRoot(workspaceId, ["chown", "-R", `root:${APP_GID}`, target]),
    runRoot(workspaceId, ["find", target, "-type", "f", "-exec", "chmod", "0640", "{}", "+"]),
    runRoot(workspaceId, ["find", target, "-type", "d", "-exec", "chmod", "0755", "{}", "+"]),
  ]);
  if (r1.code !== 0 || r2.code !== 0 || r3.code !== 0) {
    log.warn({ workspaceId, relPath, chown: r1.stderr, chmodF: r2.stderr, chmodD: r3.stderr }, "hideOnDisk failed");
  }
  const parentDir = path.posix.dirname(target);
  if (parentDir !== "/") {
    await Promise.all([
      runRoot(workspaceId, ["chown", "root:developer", parentDir]),
      runRoot(workspaceId, ["chmod", "01775", parentDir]),
    ]);
  }
}

// Public: lock/unlock a single path. Callers (the permissions/privileged-scripts routes) must have ensured the
// container is running first. No-op-safe when globally locked is handled by the caller.
export async function lockPathOnDisk(workspaceId: string, relPath: string): Promise<void> {
  await lockOnDisk(workspaceId, relPath);
}

export async function unlockPathOnDisk(workspaceId: string, relPath: string): Promise<void> {
  await unlockOnDisk(workspaceId, relPath);
}

// Public: hide/unhide a single path. Hiding blocks the agent from reading content; unhiding returns
// the path to normal developer ownership (same as unlock). Callers must ensure the container first.
export async function hidePathOnDisk(workspaceId: string, relPath: string): Promise<void> {
  await hideOnDisk(workspaceId, relPath);
}

export async function unhidePathOnDisk(workspaceId: string, relPath: string): Promise<void> {
  await unlockOnDisk(workspaceId, relPath);
}

// Brings the whole workspace into the canonical on-disk state. Called at the end of
// `_ensureContainer` so locks + privileged scripts survive container restart/recreate.
//
// While the workspace is GLOBALLY locked the bind mount is read-only (`:ro`), which enforces
// everything at the mount level and would make chown/chmod fail — so we skip the per-path work.
export async function reconcileOsPermissions(workspaceId: string): Promise<void> {
  const snap = await readPermissionSnapshot(workspaceId);
  if (snap.globalLock) return; // read-only mount already enforces it

  // Normalize so the agent can do normal work.
  // Files: chown non-root-owned files to developer (root-owned = protected, leave alone) and make
  // them owner-writable. The re-lock loop below will re-assert a-w on the protected set.
  await runRoot(workspaceId, ["find", "/workspace", "-type", "f", "!", "-uid", "0", "-exec", "chown", DEVELOPER, "{}", "+"]);
  await runRoot(workspaceId, ["find", "/workspace", "-type", "f", "!", "-uid", "0", "-exec", "chmod", "u+w", "{}", "+"]);
  // Directories: set all to root:developer 01775 (sticky + group-write). This includes /workspace
  // itself (no -mindepth 1 restriction), fixing it so developer can write/delete its own files
  // there. Sticky bit means developer — despite having group-write — can only unlink files it owns,
  // so root-owned (locked/hidden) entries survive `rm`. The re-lock loop re-asserts a-w on locked
  // directory subtrees after this baseline is set.
  await runRoot(workspaceId, ["find", "/workspace", "-type", "d", "-exec", "chown", "root:developer", "{}", "+"]);
  await runRoot(workspaceId, ["find", "/workspace", "-type", "d", "-exec", "chmod", "01775", "{}", "+"]);

  // Hidden paths get root:APP_GID 0640 (content unreadable by the agent). Apply these FIRST and
  // exclude them from the lock set below so the lock's 0444/a-w doesn't clobber the hide mode bits.
  const hidden = listHidden(workspaceId);
  for (const relPath of hidden) {
    await hideOnDisk(workspaceId, relPath);
  }

  // Then re-lock the protected set: registered per-path locks + privileged scripts (which are locked
  // so the agent can't edit them), minus anything already hidden. Dedupe so a path that's both
  // locked and privileged is done once.
  const hiddenSet = new Set(hidden);
  const protectedPaths = new Set<string>(
    [...snap.locked, ...listPrivileged(workspaceId)].filter((p) => !hiddenSet.has(p))
  );
  for (const relPath of protectedPaths) {
    await lockOnDisk(workspaceId, relPath);
  }
  if (protectedPaths.size > 0 || hidden.length > 0) {
    log.debug({ workspaceId, locked: protectedPaths.size, hidden: hidden.length }, "reconciled OS permissions");
  }
}

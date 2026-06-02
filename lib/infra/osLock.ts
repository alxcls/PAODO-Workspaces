// OS-level enforcement of file locks and secured-script protection inside a workspace container.
//
// The agent's `execute_command` runs as the non-root `developer` user, so the kernel — not the
// system prompt — is what actually stops it from writing locked files or reading hidden secrets.
// This module owns the privileged side of that boundary: it runs `docker exec -u root` to set
// ownership/mode bits so that:
//   - LOCKED paths   → root:root, write bit cleared (a-w) → files 0444, dirs 0555. `developer`
//                      cannot write them, even via a script it writes.
//   - UNLOCKED paths → developer:developer, owner-writable (u+w) → files 0644, dirs 0755.
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
//   - Production (Linux host, bind mount or named volume): a real Linux filesystem. `chown` and
//     `chmod` are fully enforced by the kernel — developer cannot write a root-owned 0444 file,
//     even via a script that calls write_text() directly, bypassing the tool-layer lock check.
//   - Local macOS dev (Docker Desktop bind mount via gRPC-FUSE): mode bits and ownership inside
//     the container are NOT enforced for writes. The host macOS user owns every inode; writes from
//     inside the container pass straight through regardless of chown/chmod. Locks are therefore
//     advisory in dev — they block the tool-layer check (file_write/file_edit) but NOT direct
//     filesystem writes from scripts. Secret hiding is unaffected (process-env + UID separation,
//     not a mount property). The chown/chmod calls below are kept because they are correct and
//     load-bearing in production; they are cosmetic on the Docker Desktop macOS mount.
import { spawn } from "child_process";
import { readPermissionSnapshot } from "./permissionStore";
import { listSecured } from "./securedScriptStore";
import { createLogger } from "./logger";

const log = createLogger("osLock");

const DEVELOPER = "developer:developer";

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
// can rewrite it. Idempotent.
async function lockOnDisk(workspaceId: string, relPath: string): Promise<void> {
  const target = `/workspace/${relPath}`;
  const r1 = await runRoot(workspaceId, ["chown", "-R", "root:root", target]);
  const r2 = await runRoot(workspaceId, ["chmod", "-R", "a-w", target]);
  if (r1.code !== 0 || r2.code !== 0) {
    log.warn({ workspaceId, relPath, chown: r1.stderr, chmod: r2.stderr }, "lockOnDisk failed");
  }
}

// Returns a path to `developer` ownership and owner-writable (u+w) → 0644 files / 0755 dirs.
async function unlockOnDisk(workspaceId: string, relPath: string): Promise<void> {
  const target = `/workspace/${relPath}`;
  const r1 = await runRoot(workspaceId, ["chown", "-R", DEVELOPER, target]);
  const r2 = await runRoot(workspaceId, ["chmod", "-R", "u+w", target]);
  if (r1.code !== 0 || r2.code !== 0) {
    log.warn({ workspaceId, relPath, chown: r1.stderr, chmod: r2.stderr }, "unlockOnDisk failed");
  }
}

// Public: lock/unlock a single path. Callers (the permissions/secured-scripts routes) must have ensured the
// container is running first. No-op-safe when globally locked is handled by the caller.
export async function lockPathOnDisk(workspaceId: string, relPath: string): Promise<void> {
  await lockOnDisk(workspaceId, relPath);
}

export async function unlockPathOnDisk(workspaceId: string, relPath: string): Promise<void> {
  await unlockOnDisk(workspaceId, relPath);
}

// Brings the whole workspace into the canonical on-disk state. Called at the end of
// `_ensureContainer` so locks + secured scripts survive container restart/recreate.
//
// While the workspace is GLOBALLY locked the bind mount is read-only (`:ro`), which enforces
// everything at the mount level and would make chown/chmod fail — so we skip the per-path work.
export async function reconcileOsPermissions(workspaceId: string): Promise<void> {
  const snap = await readPermissionSnapshot(workspaceId);
  if (snap.globalLock) return; // read-only mount already enforces it

  // Normalize so the agent can do normal work. Only chown NON-root files to developer: root-owned
  // paths are intentionally protected (locked files AND secured-script outputs) and must survive
  // restart, so leave their ownership alone. The chmod u+w is applied broadly (cheap, and the
  // re-lock loop below re-asserts a-w on the protected set) so unlocked files stay writable.
  await runRoot(workspaceId, ["find", "/workspace", "-mindepth", "1", "!", "-uid", "0", "-exec", "chown", DEVELOPER, "{}", "+"]);
  await runRoot(workspaceId, ["chmod", "-R", "u+w", "/workspace"]);

  // Then re-lock the protected set: registered per-path locks + secured scripts (which are locked
  // so the agent can't edit them). Dedupe so a path that's both locked and secured is done once.
  const protectedPaths = new Set<string>([...snap.locked, ...listSecured(workspaceId)]);
  for (const relPath of protectedPaths) {
    await lockOnDisk(workspaceId, relPath);
  }
  if (protectedPaths.size > 0) {
    log.debug({ workspaceId, count: protectedPaths.size }, "reconciled OS permissions");
  }
}

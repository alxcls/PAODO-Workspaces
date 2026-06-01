// OS-level enforcement of file locks and crowned-script protection inside a workspace container.
//
// The agent's `execute_command` runs as the non-root `developer` user, so the kernel — not the
// system prompt — is what actually stops it from writing locked files or reading hidden secrets.
// This module owns the privileged side of that boundary: it runs `docker exec -u root` to set
// ownership/mode bits so that:
//   - LOCKED paths   → root:root, write bit cleared (a-w) → files 0444, dirs 0555. `developer`
//                      cannot write them, even via a script it writes.
//   - UNLOCKED paths → developer:developer, owner-writable (u+w) → files 0644, dirs 0755.
//
// Root ownership is the durable signal for "protected": both manually-locked paths AND the outputs
// a crowned script creates (it runs as root) are root-owned, so `reconcileOsPermissions` normalizes
// only NON-root files back to developer and never demotes a protected path. run_crowned_script
// registers a crowned run's root-owned outputs as locked so they're protected at the registry layer
// too (file_write/file_edit gate on the registry, not on disk ownership).
//
// It deliberately does NOT import containerManager: `reconcileOsPermissions` is invoked from
// inside `_ensureContainer`, so going through `dockerExec` (which calls `ensureContainer`) would
// deadlock on the start-lock. Instead it spawns `docker exec` directly. Callers that run OUTSIDE
// container creation (the permissions route) must `ensureContainer` themselves first.
//
// ENFORCEMENT MODEL — depends on the mount type:
//   - Production (Docker named volume, e.g. on the Debian VPS): a real Linux filesystem. `chown`
//     works, root overrides mode bits, so the full ownership model holds: developer-vs-root is a
//     real boundary, and a crowned script (root) can rewrite a locked (0444) file.
//   - Local macOS dev (Colima virtiofs bind mount): `chown` is a no-op (every file maps to the
//     host user and shows as root:root) and mode bits are enforced even against container-root.
//     So enforcement degrades to MODE BITS ONLY — a 0444 file still blocks the agent's writes
//     (the lock works), but root cannot rewrite a 0444 file either, and the dev/root ownership
//     split is cosmetic. Secret hiding is unaffected on both (it's process-env + UID separation,
//     not a mount property). The chown calls below are kept because they are correct and load-
//     bearing in production; they are simply inert on the macOS virtiofs mount.
import { spawn } from "child_process";
import { readPermissionSnapshot } from "./permissionStore";
import { listCrowned } from "./crownedScriptStore";
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

// Public: lock/unlock a single path. Callers (the permissions/crown routes) must have ensured the
// container is running first. No-op-safe when globally locked is handled by the caller.
export async function lockPathOnDisk(workspaceId: string, relPath: string): Promise<void> {
  await lockOnDisk(workspaceId, relPath);
}

export async function unlockPathOnDisk(workspaceId: string, relPath: string): Promise<void> {
  await unlockOnDisk(workspaceId, relPath);
}

// Lists every path under /workspace as workspace-relative paths. run_crowned_script snapshots this
// before and after a run to find the script's OUTPUTS by diff (new paths) — robust on both a real
// Linux fs and on macOS virtiofs (where ownership is meaningless because everything maps to one
// uid, so an ownership-based heuristic would match the whole tree). Returns [] on error.
export async function listWorkspacePaths(workspaceId: string): Promise<string[]> {
  // %P prints the path relative to /workspace (the find root), i.e. the workspace-relative path.
  const r = await runRoot(workspaceId, ["find", "/workspace", "-mindepth", "1", "-printf", "%P\\n"]);
  if (r.code !== 0) {
    log.warn({ workspaceId, stderr: r.stderr }, "listWorkspacePaths failed");
    return [];
  }
  return r.stdout.split("\n").map((p) => p.trim()).filter(Boolean);
}

// Brings the whole workspace into the canonical on-disk state. Called at the end of
// `_ensureContainer` so locks + crowns survive container restart/recreate.
//
// While the workspace is GLOBALLY locked the bind mount is read-only (`:ro`), which enforces
// everything at the mount level and would make chown/chmod fail — so we skip the per-path work.
export async function reconcileOsPermissions(workspaceId: string): Promise<void> {
  const snap = await readPermissionSnapshot(workspaceId);
  if (snap.globalLock) return; // read-only mount already enforces it

  // Normalize so the agent can do normal work. Only chown NON-root files to developer: root-owned
  // paths are intentionally protected (locked files AND crowned-script outputs) and must survive
  // restart, so leave their ownership alone. The chmod u+w is applied broadly (cheap, and the
  // re-lock loop below re-asserts a-w on the protected set) so unlocked files stay writable.
  await runRoot(workspaceId, ["find", "/workspace", "-mindepth", "1", "!", "-uid", "0", "-exec", "chown", DEVELOPER, "{}", "+"]);
  await runRoot(workspaceId, ["chmod", "-R", "u+w", "/workspace"]);

  // Then re-lock the protected set: registered per-path locks + crowned scripts (which are locked
  // so the agent can't edit them). Dedupe so a path that's both locked and crowned is done once.
  const protectedPaths = new Set<string>([...snap.locked, ...listCrowned(workspaceId)]);
  for (const relPath of protectedPaths) {
    await lockOnDisk(workspaceId, relPath);
  }
  if (protectedPaths.size > 0) {
    log.debug({ workspaceId, count: protectedPaths.size }, "reconciled OS permissions");
  }
}

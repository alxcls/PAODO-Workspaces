// Projects the permissionStore state onto real OS ownership/modes inside the workspace container,
// so the per-file agent permission model is enforced by the Linux kernel — not by tool-layer checks
// the agent can bypass by writing and running its own script.
//
// Identity scheme (see Dockerfile.workspace and doc/adr/accepted/adr-agent-permission-model.md):
//   agent (1001, group paodo)          — the LLM; owns normal files.
//   privd (1002, groups privd + paodo) — runs privileged scripts; OWNS all protected files.
//   group privd (1002)                 — used as the group on protected files; the agent is NOT a
//                                         member, so it falls to "other": read-only on locked, none
//                                         on hidden. group paodo (agent + privd) is the normal group.
//
// Per-path representation (precedence: privileged > hidden > locked — a path may be in several lists):
//   privileged  privd:privd  0700 (file) / 0700 (dir)   — agent: none; invoked only via privd.
//   hidden      privd:privd  0600 (file) / 2700 (dir)   — agent: none (name still listed by parent).
//   locked      privd:privd  0644|0755 (file) / 2755 (dir) — agent: r / r-x (read-only).
//   normal      agent:paodo  (chown only; modes left as-is, group-writable via umask 002).
//
// Directories that merely CONTAIN a protected path (but are not themselves protected) are hardened to
// node:paodo 3775 (setgid + sticky): the agent can create its own files but the sticky bit blocks it
// from unlinking or renaming the privd-owned protected entry.
import path from "path";
import { getPermissions } from "./permissionStore";

export type RootExec = (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

type ProtectedState = "privileged" | "hidden" | "locked";

const WORKSPACE = "/workspace";

// One self-contained snippet applied per protected path. Handles file-vs-directory and preserves the
// execute bit on locked scripts (lock = write-protection, not execution prevention). $1=abs path,
// $2=state. Runs as root, so chown to privd:privd always succeeds.
const APPLY_SCRIPT = `
set -e
p="$1"; state="$2"
[ -e "$p" ] || exit 0
case "$state" in
  privileged) chown -R privd:privd "$p"
              if [ -d "$p" ]; then find "$p" -type d -exec chmod 0700 {} +; find "$p" -type f -exec chmod 0700 {} +; else chmod 0700 "$p"; fi ;;
  hidden)     chown -R privd:privd "$p"
              if [ -d "$p" ]; then find "$p" -type d -exec chmod 2700 {} +; find "$p" -type f -exec chmod 0600 {} +; else chmod 0600 "$p"; fi ;;
  locked)     chown -R privd:privd "$p"
              if [ -d "$p" ]; then
                find "$p" -type d -exec chmod 2755 {} +
                find "$p" -type f -perm -u+x -exec chmod 0755 {} +
                find "$p" -type f ! -perm -u+x -exec chmod 0644 {} +
              elif [ -x "$p" ]; then chmod 0755 "$p"
              else chmod 0644 "$p"; fi ;;
esac
`;

// Restores a path to the normal (agent-owned, group-writable) state. chown only — modes are left
// intact so an executable agent script keeps its +x. $1=abs path.
const NORMALIZE_SCRIPT = `
set -e
p="$1"
[ -e "$p" ] || exit 0
chown -R agent:paodo "$p"
`;

function abs(relPath: string): string {
  return path.posix.join(WORKSPACE, relPath);
}

// Effective on-disk state for a path given the three lists, applying precedence.
function effectiveState(
  relPath: string,
  perms: { locked: string[]; hidden: string[]; privileged: string[] },
): ProtectedState | null {
  if (perms.privileged.includes(relPath)) return "privileged";
  if (perms.hidden.includes(relPath)) return "hidden";
  if (perms.locked.includes(relPath)) return "locked";
  return null;
}

// Ancestor directories of a path, from shallowest to deepest, excluding the workspace root and the
// path itself. e.g. "a/b/c.txt" → ["a", "a/b"].
function ancestors(relPath: string): string[] {
  const parts = relPath.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

async function applyPath(rootExec: RootExec, relPath: string, state: ProtectedState): Promise<void> {
  await rootExec(["bash", "-c", APPLY_SCRIPT, "_", abs(relPath), state]);
}

async function normalizePath(rootExec: RootExec, relPath: string): Promise<void> {
  await rootExec(["bash", "-c", NORMALIZE_SCRIPT, "_", abs(relPath)]);
}

// Hardens a directory so the agent can create its own files but cannot unlink files it doesn't own.
async function hardenDir(rootExec: RootExec, relPath: string): Promise<void> {
  await rootExec(["chown", "node:paodo", abs(relPath)]);
  await rootExec(["chmod", "3775", abs(relPath)]);
}

/**
 * Re-apply OS ownership/modes from the permission store.
 *
 * @param rootExec  Runs a command as root inside the workspace container.
 * @param workspaceId
 * @param relPath   Targeted mode: reconcile just this path (+ its ancestors) after a toggle.
 *                  Omit for a full sweep (container (re)create): normalize the whole tree, then
 *                  re-apply every protected path.
 */
export async function reconcileOsPermissions(
  rootExec: RootExec,
  workspaceId: string,
  relPath?: string,
): Promise<void> {
  const perms = getPermissions(workspaceId);
  const allProtected = new Set([...perms.locked, ...perms.hidden, ...perms.privileged]);

  // Ancestor dirs that contain a protected path but are not themselves protected → harden them.
  const hardenSet = new Set<string>();
  for (const p of allProtected) for (const a of ancestors(p)) if (!allProtected.has(a)) hardenSet.add(a);

  if (relPath === undefined) {
    // Full sweep. Normalize everything to agent ownership first, then re-apply protected paths so
    // their privd ownership/modes win. Root (/workspace) is always non-agent-owned + sticky so the
    // agent can never unlink a top-level protected entry.
    await rootExec(["chown", "-R", "agent:paodo", WORKSPACE]);
    await rootExec(["chown", "node:paodo", WORKSPACE]);
    await rootExec(["chmod", "3775", WORKSPACE]);
    for (const dir of hardenSet) await hardenDir(rootExec, dir);
    // Apply shallower paths first so a protected directory's own mode is set before its protected
    // descendants (descendants then override within their subtree).
    const ordered = [...allProtected].sort((a, b) => a.split("/").length - b.split("/").length);
    for (const p of ordered) {
      const state = effectiveState(p, perms);
      if (state) await applyPath(rootExec, p, state);
    }
    return;
  }

  // Targeted: just the toggled path + its non-protected ancestors.
  for (const a of ancestors(relPath)) if (hardenSet.has(a)) await hardenDir(rootExec, a);
  const state = effectiveState(relPath, perms);
  if (state) await applyPath(rootExec, relPath, state);
  else await normalizePath(rootExec, relPath);
}

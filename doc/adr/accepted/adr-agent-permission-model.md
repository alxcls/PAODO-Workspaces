# ADR — Agent permission model (hidden / locked / privileged files)

Status: Accepted

## Context

The agent runs untrusted, model-generated actions against a real filesystem and shell. Both its file
tools (`file_read`/`file_write`/`file_edit`/`glob`/`list_directory`) and `execute_command` route through
the **same** `docker exec` into the per-workspace container, so they share one OS boundary. A terminal
agent scans the tree freely (`grep -r`, `cat`) and can write a script and run it — so any protection
that lives only in the tool layer is worthless (see `doc/agent-lock-bypass.md`): it must hold against
arbitrary shell commands, enforced by the kernel.

Users need three controls over any file or folder:

- **Hidden** — the agent cannot read its content (confidential data).
- **Locked** — the agent cannot modify or delete it, but may still read/run it (frozen reference/scripts).
- **Privileged** — a trusted script the agent may only *run* (never edit), which itself can read hidden
  files and write locked files (the approved way to mutate protected data).

Current `main` had collapsed the agent and the app server onto the **same uid (1000)** so the app could
manage agent files with no chown. Hiding a file from the agent but not the app is impossible when they
share a uid — so the model requires splitting them.

## Decision

### Three container identities + the app, two groups

(`Dockerfile.workspace`)

| uid | user | groups | role |
|----|------|--------|------|
| 1000 | `node` | `paodo` | app/owner side; ownership only, not a workspace exec identity |
| 1001 | `agent` | `paodo` | the LLM; default `docker exec` user for ALL file tools + `execute_command` |
| 1002 | `privd` | `privd` (primary) + `paodo` | runs privileged scripts; **owns all protected files** |

Groups: **`paodo`** (1000) = {node, agent, privd} for normal-file collaboration; **`privd`** (1002) =
{privd} used as the *group* on protected files so the agent — not a member — falls to "other".

`root` is reachable only via `docker exec -u 0` from the server (`apt_install`, the permission reconcile,
and the app's read/write/delete fallback). The agent can never compose a root or privd command: its
shell is non-root, there is no setuid path, and `--security-opt no-new-privileges` blocks escalation.
`execute_command` additionally rejects `sudo` outright.

### State of record + reconcile

The three lists live in JSON **outside** the workspace bind mount
(`WORKSPACES_ROOT/.agent-permissions/<id>.json`, `lib/infra/permissionStore.ts`), so the agent has no
path to read or tamper with them. `reconcileOsPermissions` (`lib/infra/osLock.ts`) projects that state
onto OS ownership/modes via root `docker exec` — on container (re)create (full sweep) and after every
toggle (targeted). On-disk ownership is the durable signal; it survives restarts on the volume.

Per-path representation (precedence **privileged > hidden > locked**, since a privileged path is also
locked):

| State | owner:group | file mode | dir mode | agent | privd | app |
|-------|-------------|-----------|----------|-------|-------|-----|
| Normal | `agent:paodo` | 664 | 2775 | rw (owner) | rw (group) | host-fs read / root-exec write |
| Locked | `privd:privd` | 644 / 755 (exec) | 2755 | **r / r-x (other)** | rw (owner) | root-exec |
| Hidden | `privd:privd` | 600 | 2700 | **none (other)** | rw (owner) | root-exec |
| Privileged | `privd:privd` | 700 | 700 | **none** (runs via tool) | rwx (owner) | root-exec |

Directories that merely **contain** a protected path (but aren't themselves protected) are hardened to
`node:paodo 3775` (setgid + sticky): the agent (group `paodo`) can create its own files, but the sticky
bit + non-ownership blocks it from unlinking or renaming the `privd`-owned protected entry — closing the
"delete and recreate" bypass. The workspace root is always non-agent-owned + sticky for the same reason.
A container-wide `umask 002` (set at the single exec chokepoint in `containerManager`) keeps
agent/privd-created files group-writable so collaboration on normal files needs no chown.

### Coupling and execution

- **privilege ⇒ lock** (granting privilege auto-locks so the agent can't tamper with a trusted script);
  revoking privilege keeps the lock; **unlocking revokes privilege** (`[RW]+[P]` is invalid). Hidden is
  fully independent. The store owns these invariants.
- Privileged scripts run via the dedicated **`run_privileged_script`** tool, which verifies the path is
  registered privileged and execs it as `privd` (`docker exec -u privd`) from its own directory. There is
  no command parsing — the path is explicit, so nothing can be smuggled into the privileged identity.
- The app server is trusted infra: for protected files (owned by `privd`) its direct host-fs syscalls hit
  `EACCES`, so the file content routes fall back to **root** `docker exec` for read/write/delete. This is
  what guarantees "the user can always see and modify hidden/locked content" without weakening the agent's
  kernel restrictions, and removes any app-container GID-pinning constraint.

The agent always sees the protection state: `buildProtectionBlock` injects a `[R]`/`[H]`/`[P]` summary
into the system prompt, and the file tools turn a kernel `EACCES` into actionable guidance.

## Consequences

- **Enabled:** protections that survive the agent writing and running its own scripts; one ownership
  change blocks `file_read`, `cat`, `grep`, `file_write`, and `rm` together; state survives restarts.
- **Cost:** the agent and app no longer share a uid, so the app pays a root `docker exec` round-trip when
  it reads/writes/deletes a *protected* file (rare; normal files stay on the fast host-fs path). Reconcile
  does a tree chown on container create.
- **Deployment:** the workspace image must be rebuilt when uids change (`docker rmi paodo-workspace`); the
  server recreates containers automatically on the next command.
- **macOS local dev:** with legacy gRPC-FUSE, mode bits inside the container are advisory, so write-locks
  are advisory there (same caveat as the prior lock design). On Linux (the production VPS) and VirtioFS,
  everything is kernel-enforced. Confidentiality (hidden) holds in all cases via uid separation.

## Alternatives considered

- **Tool-layer checks only** — bypassable by an agent-written script. Rejected (the whole motivation).
- **Privileged scripts run as root** (the earlier `feat/agent-privilege-model` branch) — unbounded blast
  radius and required a fragile post-run sweep to reclaim root-owned output files. Replaced by non-root
  `privd`.
- **Hidden via an `APP_GID` group the app container shares** (both prior branches) — pinned the app
  container's gid and added a deployment constraint. Replaced by the app's root-exec fallback, which
  decouples the app entirely from the workspace uid scheme.
- **Four identities** (`agent`/`privd`/`appuser`/`developer`, the `permission-model` branch) — collapsed
  to three (the app reuses uid 1000; no separate toolchain user).
- **`chattr +i` immutable flag** — needs `CAP_LINUX_IMMUTABLE`, dropped under `no-new-privileges`.
- **Detecting a privileged program inside an arbitrary `execute_command`** (lexer in the earlier branch) —
  fragile. Replaced by an explicit `run_privileged_script` tool.

## Notes

- PRD: `doc/prd/accepted/prd-agent-permission-model.md`
- Enforcement: `lib/infra/permissionStore.ts`, `lib/infra/osLock.ts`, `Dockerfile.workspace`,
  `lib/infra/docker/containerManager.ts`
- Tools & prompt: `lib/agent/tools/runPrivilegedScript.ts`, `lib/agent/tools/tags.ts`,
  `lib/agent/tools/execCommand.ts` (sudo guard), `lib/agent/promptContext.ts`
- Routes & UI: `app/api/workspaces/[id]/permissions/route.ts`, `app/api/workspaces/[id]/files/{route,content/route}.ts`,
  `components/workspace/FileTreePanel.tsx`
- Out of scope (v1): workspace secret injection, a workspace-wide global read-only mode, per-user roles.
- Supersedes the bypass documented in `doc/agent-lock-bypass.md`.

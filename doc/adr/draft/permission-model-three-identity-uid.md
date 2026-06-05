# ADR — Permission model: three-identity UID system (Eye / Lock / Key)

Status: Draft

## Context

Two gaps in the original access-control layer:
1. The agent could read every file in the workspace, including secrets.
2. Per-file software locks blocked tool calls but not shell commands spawned via `execCommand` — no OS-level enforcement of write protection.

## Decision

Three named identities run inside the workspace container. The kernel enforces access based on UID/GID; the server mediates which identity executes each operation.

### Identities

| Identity | UID | Name | Group membership | Purpose |
|---|---|---|---|---|
| Agent | 999 | `agent` | none (`access`) | AI tool calls and shell; always "other" on locked/hidden files |
| Privileged | 998 | `privd` | `access` (gid 1001) | Owns locked files; runs keyed scripts |
| App user | 1002 | `appuser` | `access` (gid 1001) | UI editor writes in the workspace |

Root is used transiently only inside the container for `chown`/`chmod` reconciliation and `apt-get install`; it is never an ongoing execution identity.

### Ownership and mode matrix

| State | Owner UID | Group GID | File mode | Dir mode | Agent (999) | App user (1002) | Privd (998) |
|---|---|---|---|---|---|---|---|
| Normal | 999 | 1001 | 664 | 3775 | rw | rw (group) | rw (group) |
| Eye-off | 1002 | 1001 | 662 | 3773 | -w- | rw (owner) | rw (group) |
| Lock | 998 | 1001 | 644 | 755 | r | r (group) | rw (owner) |
| Eye-off + Lock | 998 | 1001 | 640 | 750 | — | r (group) | rw (owner) |

Normal directories carry setgid + sticky so new files inherit `group=access` while the agent cannot unlink privd-owned entries. Eye-off directories now keep both bits but drop the read bit for "other", leaving only `wx` so the agent can reach known paths without listing them. When the workspace is globally locked—or when a locked/keyed path sits directly at the workspace root—`/workspace` itself flips to privd ownership. Under global lock it lands at mode `3775` (read-only); otherwise it uses `3777` so the agent can still add new root entries while sticky-bit rules stop it from deleting privd-owned files.

### Eye — read visibility

Hidden paths are `chown`ed to uid 1002. Files get mode `662` (agent user retains `-w-` but no read bit) and directories get `3773` (agent has `wx` so it can target known paths without listing contents). uid 999 remains "other" so the kernel denies reads before any tool logic runs, while still allowing pure write syscalls. `fileRead` additionally calls `isAgentHidden()` to return a descriptive error rather than raw `EACCES`; this is UX only.

### Lock — write protection

Locked paths are `chown`ed to uid 998 with mode `644`/`755`. uid 999 is "other" with only the read bit; the kernel denies all write syscalls from both the agent and shell. uid 1002 is in `access` but also only has the read bit via group — the UI editor is blocked by the kernel too. `fileWrite`/`fileEdit` call `isAgentLocked()` for a clean error message; again UX only. Ancestor directories that contain any locked/keyed entry are also `chown`ed to uid 998 with mode `3775`, and the workspace root enters the same state whenever a guarded entry lives directly under it or `globalLock` is enabled. This prevents the agent (uid 999) from deleting-and-recreating locked files via TOCTOU shell tricks, even when the files are stored at the top level.

### Key — privileged script execution

The Linux kernel disables setuid for interpreted scripts, so there is no kernel path to auto-elevate. Instead, `permissionStore` maintains a `keyed: string[]` list. When `execCommand` detects `sudo` in the agent command, it:

1. Matches the script path against `/workspace/<relPath>`.
2. Checks `isKeyedFromSnapshot()` — rejects if the path is not marked keyed.
3. Strips all `sudo` tokens from the command string.
4. Runs the command via `docker exec -u privd` instead of `docker exec -u agent`.

The agent never self-elevates; the server is the sole authority for the identity switch. Key is granted only by the operator via the UI.

### Tool-to-identity dispatch

| Tool | Runs as |
|---|---|
| `fileRead`, `fileWrite`, `fileEdit`, `glob` | uid 999 (`asAgent: true`) |
| `execCommand` (normal) | uid 999 (`-u agent`) |
| `execCommand` (keyed path with sudo) | uid 998 (`-u privd`) |
| `listDirectory` | root (no `-u` flag — must stat hidden files) |
| `install_system_package` | root via `runRoot()` in `aptBroker` |

### Reconciliation

`reconcileOsPermissions(workspaceId, relPath?)` (in `lib/infra/osLock.ts`) re-applies correct ownership and modes via `docker exec` as root. It has two modes:

- **Targeted** (`relPath` provided): `chown`/`chmod` that path's subtree, then restore `+x` on all keyed scripts via `reconcileKeyedExecutable`.
- **Full sweep** (no `relPath`): first normalises any root-owned artifacts left by `apt-get` to Normal state (uid 999), then re-applies each configured path shallower-first so deeper paths override parent settings, then restores keyed `+x`.

Called after every permission toggle and every `apt-get install`. `applyKeyedExecutable` is also called at container start so keyed scripts survive container recreation.

Permission state is persisted to `.agent-permissions/<workspaceId>.json` on the host (outside the container), with fields: `globalLock`, `locked[]`, `hidden[]`, `keyed[]`.

## Consequences

- Agent cannot read hidden files or write locked files via any execution path — tool calls and raw shell commands both hit the same kernel rules.
- Keyed scripts run as privd and can write locked files; no other identity can.
- `reconcileOsPermissions` must be called after every toggle and every apt install to keep OS state consistent with the store.
- `install_system_package` (agent tool) and the apt broker refuse to run while `globalLock` is enabled; the workspace volume is remounted read-only so no identity (even root) can modify files until it is lifted.
- A chmod applied by `applyMode` strips `+x`; `reconcileKeyedExecutable` must always follow to restore it.
- Workspace container must be rebuilt if UIDs change (`docker rmi paodo-workspace`).
- Non-root directories automatically flip between agent-owned (Normal) and privd-owned (guarded) based on whether they contain locked/keyed descendants, closing unlink/replace races while restoring write access once the descendant list is empty.
- `listDirectory` runs as root to list hidden paths — the agent sees their names but not their content.

## Alternatives rejected

- **Software-only gates:** `execCommand` is an unguarded bypass; shell writes ignore tool-level checks.
- **setuid on scripts:** kernel disables it for interpreted scripts (`.sh`, `.py`, `.ts`).
- **Owner-only scheme (no shared group):** cannot express Eye-off+Lock simultaneously without ACLs.
- **Root for keyed scripts:** unbounded blast radius; rejected by design.
- **sudo inside the container:** no-new-privileges flag on the container disables privilege escalation; intercepted at the server layer instead.

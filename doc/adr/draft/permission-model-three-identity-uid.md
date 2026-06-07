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
| Agent | 999 | `agent` | none | AI tool calls and shell; always "other" on locked files |
| Privileged | 998 | `privd` | `access` (gid 1001) | Owns locked/keyed files; runs keyed scripts |
| App user | 1002 | `appuser` | `access` (gid 1001) | UI editor writes in the workspace |
| Developer | 1001 | `developer` | — | Toolchain owner only; not a workspace execution identity |

Root is used transiently only inside the container for `chown`/`chmod` reconciliation and `apt-get install`; it is never an ongoing execution identity.

### Ownership and mode matrix

Eye and Lock/Key are mutually exclusive by file type: Eye applies only to non-executables (data, config); Lock and Key apply only to executables (scripts). There is no combined Eye+Lock state.

| State | Applies to | Owner UID | Group GID | File mode | Dir mode | Agent (999) | App user (1002) | Privd (998) |
|---|---|---|---|---|---|---|---|---|
| Normal | any | 999 | 1001 | 664 | 3775 | rw | rw (group) | rw (group) |
| Eye-off | non-executable | 999 | 1001 | 262 | 3775 | -w- (owner) | rw (group) | rw (group) |
| Lock | executable | 998 | 1001 | 644 | 755 | r— (other) | r— (group) | rw (owner) |
| Keyed | executable | 998 | 1001 | 755 | 755 | r-x (other) | r-x (group) | rwx (owner) |

Eye-off keeps agent as owner but sets mode `262` — the agent's own read bit is cleared, so the kernel denies reads before any tool logic runs; write is retained to allow patching hidden config files. Normal directories carry setgid + sticky so new files inherit `group=access` while the agent cannot unlink privd-owned entries. When the workspace is globally locked—or when a locked/keyed path sits directly at the workspace root—`/workspace` itself flips to privd ownership at mode `3775`.

### Eye — read visibility (non-executables only)

Eye is the protection symbol for data and config files. It is blocked for executable scripts: the Linux kernel cannot execute an interpreted script without read permission (it must read the shebang; the interpreter reads the body), so hiding a script would make it silently unexecutable. Enforced at two layers: (1) `EyeBadge` is not rendered when `isExecutable(node.name)` or `node.privileged` is true; (2) `PATCH /hidden` returns 400 for executable extensions.

Hidden paths remain `chown`ed to uid 999. Files get mode `262`, directories stay `3775`. The kernel denies agent reads before any tool logic runs; write is retained. `file_read` additionally calls `isAgentHidden()` to return a descriptive error rather than raw `EACCES`; this is UX only.

### Lock — write protection (executables only)

Lock is the protection symbol for executable scripts. It prevents the agent from tampering with scripts before they run as privd. Locked paths are `chown`ed to uid 998 with mode `644`/`755`. uid 999 is "other" with only the read bit; the kernel denies all write syscalls from both the agent and shell. uid 1002 is in `access` but only has the read bit via group — the UI editor is blocked by the kernel too. `file_write`/`file_edit` call `isAgentLocked()` for a clean error message; again UX only. Ancestor directories that contain any locked/keyed entry are also `chown`ed to uid 998 with mode `3775`, and the workspace root enters the same state whenever a guarded entry lives directly under it or `globalLock` is enabled. This prevents the agent from deleting-and-recreating locked files via TOCTOU shell tricks.

### Key — privileged script execution

The Linux kernel disables setuid for interpreted scripts, so there is no kernel path to auto-elevate. Instead, `permissionStore` maintains a `keyed: string[]` list.

**Key always implies Lock.** When the operator keys a script, the server first calls `setPermission(..., "R")` (Lock), then `setKeyed(..., true)`. Unkeying reverses both: `setPermission(..., "RW")` then `setKeyed(..., false)`. Keyed scripts are owned by uid 998 and get mode `755` so privd can execute them.

Privileged execution happens via a dedicated `run_keyed_script` tool:

1. The agent passes a workspace path (and optional runtime/args) to `run_keyed_script`.
2. The server resolves the path under `/workspace` and checks it via `isKeyedFromSnapshot()` — rejects if not marked keyed.
3. If keyed, the server builds the command line (optionally prefixed with the requested runtime) and runs it as `privd` (uid 998) via `docker exec`.
4. `execute_command` always runs as `agent` (uid 999) and rejects any use of `sudo`, directing the agent to `run_keyed_script` instead.

The agent never self-elevates; the server is the sole authority for the identity switch. Key is granted only by the operator via the UI.

### Tool-to-identity dispatch

| Tool | Runs as |
|---|---|
| `file_read`, `file_write`, `file_edit`, `glob` | uid 999 (`-u agent`) |
| `execute_command` | uid 999 (`-u agent`) |
| `run_keyed_script` | uid 998 (`-u privd`) |
| `list_directory` | root (no `-u` flag — must stat hidden files) |
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
- **Owner-only scheme (no shared group):** requires ACLs to give appuser read access alongside agent write-only on Eye-off files.
- **Root for keyed scripts:** unbounded blast radius; rejected by design.
- **sudo inside the container:** no-new-privileges flag on the container disables privilege escalation; intercepted at the server layer instead.

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
| Normal | 999 | 1001 | 664 | 2775 | rw | rw (group) | rw (group) |
| Eye-off | 1002 | 1001 | 660 | 2770 | — | rw (owner) | rw (group) |
| Lock | 998 | 1001 | 644 | 755 | r | r (group) | rw (owner) |
| Eye-off + Lock | 998 | 1001 | 640 | 750 | — | r (group) | rw (owner) |

Normal and Eye-off directories carry the setgid bit so new files inherit `group=access`.

### Eye — read visibility

Hidden paths are `chown`ed to uid 1002 with mode `660`/`640`. uid 999 is always "other" with `o=0`, so the kernel denies `open()` before any tool logic runs. `fileRead` additionally calls `isAgentHidden()` to return a descriptive error rather than raw `EACCES`; this is UX only.

### Lock — write protection

Locked paths are `chown`ed to uid 998 with mode `644`/`755`. uid 999 is "other" with only the read bit; the kernel denies all write syscalls from both the agent and shell. uid 1002 is in `access` but also only has the read bit via group — the UI editor is blocked by the kernel too. `fileWrite`/`fileEdit` call `isAgentLocked()` for a clean error message; again UX only.

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
- A chmod applied by `applyMode` strips `+x`; `reconcileKeyedExecutable` must always follow to restore it.
- Workspace container must be rebuilt if UIDs change (`docker rmi paodo-workspace`).
- `listDirectory` runs as root to list hidden paths — the agent sees their names but not their content.

## Alternatives rejected

- **Software-only gates:** `execCommand` is an unguarded bypass; shell writes ignore tool-level checks.
- **setuid on scripts:** kernel disables it for interpreted scripts (`.sh`, `.py`, `.ts`).
- **Owner-only scheme (no shared group):** cannot express Eye-off+Lock simultaneously without ACLs.
- **Root for keyed scripts:** unbounded blast radius; rejected by design.
- **sudo inside the container:** no-new-privileges flag on the container disables privilege escalation; intercepted at the server layer instead.

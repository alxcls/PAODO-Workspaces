# ADR — Permission model: three-identity UID system (Eye / Lock / Key)

Status: Draft

## Context

Two gaps in the existing access-control layer:
1. The agent can read every file, including secrets.
2. Per-file locks block tool calls (software gate) but not shell commands — no OS-level enforcement.

The PRD (`doc/prd/draft/prd-permission-model.md`) introduces Eye / Lock / Key to close both gaps using standard Linux UID semantics inside the workspace container.

## Decision

### Identities

| Identity | UID | User | Group | Purpose |
|---|---|---|---|---|
| Agent | 999 | `agent` | `agentgroup` | AI tool calls and shell commands; sandboxed by OS |
| Privileged | 998 | `privd` | `access` | Owns locked files; runs keyed scripts and apt installs |
| App user | 1002 | `appuser` | `access` | UI editor writes inside the workspace container |

Shared group **`access` (gid 1001)**: uid 998 and uid 1002 are members; uid 999 is not — it is always "other" on every file. Root is used transiently only for `chown`/`chmod` reconciliation and `apt-get install`.

### Ownership and mode scheme

**Files:**

| State | Owner | Mode | uid 999 | uid 1002 | uid 998 |
|---|---|---|---|---|---|
| Normal | 999 | `664` | rw | rw (group) | rw (group) |
| Eye-off | 1002 | `660` | — | rw (owner) | rw (group) |
| Lock | 998 | `644` | r | r (group) | rw (owner) |
| Eye-off + Lock | 998 | `640` | — | r (group) | rw (owner) |

Group is `access` (gid 1001) in all states.

**Directories** follow the same owner logic with modes `2775` / `2770` / `755` / `750`. Normal and Eye-off dirs carry setgid so new files automatically inherit `group=access`.

### Eye — read visibility

Hidden paths are `chown`ed to uid 1002, mode `660` (or `640` if also locked). uid 999 is always "other"; other bits are `0`, so the kernel denies `open()` unconditionally. `fileRead` also calls `isAgentHidden()` before `dockerExec` to return a descriptive error instead of raw `EACCES` — UX only, not enforcement.

### Lock — write protection

Locked paths are `chown`ed to uid 998, mode `644` / `755`. uid 999 is "other" with only the read bit; the kernel denies any write syscall. uid 1002 is in `access` and also only has the read bit via group — the UI editor is blocked by the kernel too. `fileWrite` and `fileEdit` call `isAgentLocked()` for a clean error message; again UX only.

### Key — elevated execution via server dispatch

The Linux kernel disables setuid for interpreted scripts (`.sh`, `.py`, `.ts`), so there is no kernel path to auto-elevate a script. Instead: `permissionStore` stores `keyed: string[]`; when `execCommand` sees `isKeyed()` return true for the command path, the server uses `docker exec -u privd` instead of `docker exec -u agent`. The agent never elevates itself — the server mediates the switch. Key can only be granted by the operator via the UI.

### Tool execution identities

| Tool | Runs as |
|---|---|
| `fileRead`, `fileWrite`, `fileEdit`, `glob` | uid 999 (`{ asAgent: true }`) |
| `execCommand` | uid 999; uid 998 if path is keyed |
| `listDirectory` | root (no `-u` flag) — must `stat()` hidden files too |
| `install_system_package` | root via `runRoot()` |

### apt install and reconciliation

`apt-get install` runs as root via `runRoot()` (server-mediated, package name validated against `PKG_RE`). After every apt install and every permission toggle, `reconcileOsPermissions()` runs as root to `chown`/`chmod` the affected paths back to the correct state. Configured paths are processed shallower-first so deeper paths override parent-level settings.

## Consequences

- Agent cannot read hidden files or write locked files via any path — tool calls and shell commands hit the same kernel rules.
- Keyed scripts can write locked files; no other identity can.
- `reconcileOsPermissions` must be called after every toggle and apt install.
- Workspace container must be rebuilt when UIDs change (`docker rmi paodo-workspace`).

## Alternatives rejected

- **Software-only gates:** leaves `execCommand` as an unguarded bypass.
- **setuid on scripts:** kernel disables it for interpreted scripts.
- **Owner-only scheme (no shared group):** cannot express Eye-off+Lock without ACLs.
- **Root for keyed scripts:** unbounded blast radius; PRD prohibits root as ongoing identity.

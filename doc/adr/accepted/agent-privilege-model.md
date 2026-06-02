# ADR — Agent Privilege Model (locks, secured scripts, hidden files)

Status: Accepted

## Context

The agent runs untrusted, model-generated actions against a real filesystem and shell. It has two write/read surfaces over the same per-workspace bind mount:

- **File tools** (`fileRead`, `fileWrite`, `fileEdit`, `listDirectory`, `glob`) — in-process JS.
- **Shell** (`execCommand`) — arbitrary commands inside a per-workspace Docker container.

A terminal-style agent scans the tree freely (`grep -r`, `cat`, reading configs). Any protection that lives only in the tool layer is therefore worthless: the agent can write a script and run it via the shell to do what the tool refused. We need three user-controlled guarantees — *don't change this*, *only this trusted script may change it*, *never let the model see this* — that hold against **arbitrary shell commands**, not just our tools.

## Decision

### One OS boundary, three identities

All agent file access — tools included — is routed through `docker exec` into the workspace container, so a single kernel-level ownership/mode change governs every path at once. The container image defines three identities (`Dockerfile.workspace`):

- `developer` (UID 1001) — the agent's normal identity; `execute_command` and all file tools run as this user.
- `agent` (UID 999) — more restricted; used when the workspace is globally locked.
- `root` — server-only privileged path, reachable only via `docker exec -u root` from `lib/infra/osLock.ts`. The agent can never compose a root command.

Because the kernel — not the prompt — enforces the boundary, the agent physically cannot read a root-only file or write a root-owned one, even through a script it writes and runs.

### Three independent tiers, each a registry + an on-disk state

State of record lives in JSON stores **outside** the bind mount, and is reconciled onto the filesystem whenever the container (re)starts (`reconcileOsPermissions`). Root ownership is the durable "protected" signal that survives restarts.

| Tier | Registry | On-disk (enforced) | Agent tag |
|------|----------|--------------------|-----------|
| Lock | `lib/infra/permissionStore.ts` (`.agent-permissions/<id>.json`) | `root:root`, `0444`/`0555` (no write for `developer`) | `[R]` / `[RW]` |
| Secured script | `lib/infra/securedScriptStore.ts` (`.secured-scripts.json`) | locked (root-owned) + run as root with secrets injected | `[S]` / `[US]` |
| Hidden | `lib/infra/hiddenStore.ts` (`.hidden-files.json`) | `root:APP_GID`, `0640`/`0755` (no read for `developer`) | `[H]` / `[V]` |

- **Global lock** mounts the whole volume `:ro` and drops the agent to `agent` (UID 999) — strongest, mount-level enforcement.
- **Secured scripts** are the sole privileged actor: `execCommand` transparently re-routes a command that references a secured script to `docker exec -u root` with secrets injected. They are the only way an `[R]`/`[H]` path is legitimately changed, and the agent cannot self-grant the status.
- **Hidden** uses a *three-way identity split*: `root` reads (secured scripts), the app server's group `APP_GID` reads (the user's file-tree viewer, host-side), and `developer` falls to "other" with no read. Names stay visible (directories remain listable); only content is blocked.

### Coupling and exclusivity (automatic, both directions)

Toggling secure or hidden automatically drives the lock: securing/hiding sets the path to `[R]` (registry entry + on-disk root ownership); unsecuring/revealing returns it to `[RW]` (developer-owned, via `setPermission` + `unlock`/`unhidePathOnDisk`). The lock cannot be operated independently on a protected path — `permissions/route.ts` returns `400` for a lock/unlock when `isSecured` or `isHidden`, so the key/eye is the single owner of that path's write state. `[S]` and `[H]` therefore each imply `[R]`, and the two are mutually exclusive — enforced in the UI (badges hide each other) and server-side (the secured/hidden routes reject the conflicting toggle). The agent always sees all three tags explicitly (`[write] [secure] [visibility]`); only the user can change any of them.

## Consequences

- **Enabled:** protections that survive the agent writing and running its own scripts; a single ownership change blocks `file_read`, `cat`, `grep`, and `glob` together; protected state survives restarts via reconcile.
- **Cost:** every file op pays a `docker exec` round-trip (~20–50 ms on a warm container) — accepted for the unified OS boundary.
- **Deployment constraints (hidden tier):** the app server must run with `GID = APP_GID` (default 1000) and share the workspace volume; requires non-userns-remapped Docker on a local (non-`root_squash`) filesystem. On macOS Docker Desktop the FUSE mount ignores `chown`/`chmod`, so enforcement is **advisory in local dev, kernel-real in production** — identical to existing locks.
- **Scope:** the guarantee is *confidentiality and write-protection*. Deletion-resistance is bounded by parent-directory permissions (same limitation as locks); a secured script that prints derived data is the user's responsibility.

## Alternatives considered

- **Tool-layer checks only** (original per-path lock design): bypassable by an agent-written shell script. Replaced by root-ownership enforcement.
- **`chmod` on the bind mount without a root-ownership signal:** filesystem state drifts independently of app state and reconcile can't tell "protected" from "incidental". Rejected.
- **Hidden content stored out-of-mount (like secrets), injected only at script runtime:** more robust (no UID/GID pinning) but the file stops being a normal in-place workspace file the user edits/views. Rejected in favour of in-place GID-gated files; the deployment constraint is acceptable.
- **Hidden + secured combined ("blind execution" of a proprietary script):** rejected for simplicity — `[S]`/`[H]` are mutually exclusive.
- **One collapsed tag via precedence (`H > S > R > RW`):** rejected in favour of three explicit, independent tags so the agent never has to infer a state from the absence of another.

## Notes

- PRD: `doc/prd/accepted/prd-agent-privilege-model.md`
- Enforcement: `lib/infra/osLock.ts`, `lib/infra/permissionStore.ts`, `lib/infra/securedScriptStore.ts`, `lib/infra/hiddenStore.ts`
- Tools & tags: `lib/agent/tools/tags.ts`, `lib/agent/tools/{fileRead,fileWrite,fileEdit,listDirectory,glob,execCommand}.ts`
- Routes: `app/api/workspaces/[id]/{permissions,secured-scripts,hidden,files}/route.ts`
- Container & reconcile: `lib/infra/containerManager.ts`, `Dockerfile.workspace`
- Supersedes the earlier draft ADR *File lock mechanism + trusted scripts*.

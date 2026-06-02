# ADR — Agent Privilege Model (locks, privileged scripts, hidden files)

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
| Lock | `lib/infra/permissionStore.ts` (`.agent-permissions/<id>.json`) | files `root:root 0444`, dirs `root:root 0555` (no write or delete for `developer`) | `[R]` / `[RW]` |
| Privileged script | `lib/infra/privilegeStore.ts` (`.privileged-scripts.json`) | locked (root-owned) + run as root with secrets injected | `[S]` / `[US]` |
| Hidden | `lib/infra/hiddenStore.ts` (`.hidden-files.json`) | files `root:APP_GID 0640`, dirs `root:APP_GID 0755` (no read for `developer`) | `[H]` / `[V]` |

Unlocked files are `developer:developer 0644`. **Workspace directories** (including `/workspace` itself) are always `root:developer 01775` — sticky bit + group-write. `developer` is in the `developer` group, so it can create files and delete files it owns; the sticky bit prevents it from deleting or renaming entries it does not own (i.e. root-owned locked/hidden paths), even via a script it writes. `lockOnDisk` and `hideOnDisk` also immediately fix the parent directory to `root:developer 01775` so that directories created by the agent between reconcile cycles are hardened at the moment a file inside them is protected.

- **Global lock** mounts the whole volume `:ro` and drops the agent to `agent` (UID 999) — strongest, mount-level enforcement.
- **Privileged scripts** are the sole elevated actor: `execCommand` transparently re-routes a command that references a privileged script to `docker exec -u root` with secrets injected. They are the only way an `[R]`/`[H]` path is legitimately changed, and the agent cannot self-grant the status.
- **Hidden** uses a *three-way identity split*: `root` reads (privileged scripts), the app server's group `APP_GID` reads (the user's file-tree viewer, host-side), and `developer` falls to "other" with no read. Names stay visible (directories remain listable); only content is blocked.

### Coupling and exclusivity (automatic, both directions)

Toggling privilege or hidden automatically drives the lock: granting privilege/hiding sets the path to `[R]` (registry entry + on-disk root ownership); revoking privilege/revealing returns it to `[RW]` (developer-owned, via `setPermission` + `unlock`/`unhidePathOnDisk`). The lock cannot be operated independently on a protected path — `permissions/route.ts` returns `400` for a lock/unlock when `isPrivileged` or `isHidden`, so the key/eye is the single owner of that path's write state. `[S]` and `[H]` therefore each imply `[R]`, and the two are mutually exclusive — enforced in the UI (badges hide each other) and server-side (the privileged/hidden routes reject the conflicting toggle). The agent always sees all three tags explicitly (`[write] [privilege] [visibility]`); only the user can change any of them.

## Consequences

- **Enabled:** protections that survive the agent writing and running its own scripts; a single ownership change blocks `file_read`, `cat`, `grep`, `glob`, and `rm` together; protected state survives restarts via reconcile.
- **Cost:** `reconcileOsPermissions` now runs four `find` traversals on startup instead of two — still startup-only, not in the hot path. Every file op in the agent pays a `docker exec` round-trip (~20–50 ms on a warm container) — accepted for the unified OS boundary.
- **Deployment constraints (hidden tier):** the app server must run with `GID = APP_GID` (default 1000) and share the workspace volume; requires non-userns-remapped Docker on a local (non-`root_squash`) filesystem.
- **macOS enforcement:** Docker Desktop with VirtioFS (default since Desktop 4.6) runs containers inside a Linux VM — `chown`, `chmod`, and the sticky bit are all kernel-enforced; locks are fully effective. Legacy Docker Desktop with gRPC-FUSE does not enforce mode bits or ownership for writes inside the container, so locks are **advisory** in that configuration (tool-layer checks still apply). Secret hiding is unaffected in both cases (process-env + UID separation).
- **Scope:** the guarantee covers *confidentiality, write-protection, and deletion-resistance* for locked and hidden paths. Privileged scripts that print derived data remain the user's responsibility.

## Alternatives considered

- **Tool-layer checks only** (original per-path lock design): bypassable by an agent-written shell script. Replaced by root-ownership enforcement.
- **`chmod` on the bind mount without a root-ownership signal:** filesystem state drifts independently of app state and reconcile can't tell "protected" from "incidental". Rejected.
- **`developer:developer 0755` directories (no sticky bit):** the initial directory model. Write-protection of file content worked (root-owned files couldn't be written), but `rm` on a locked file succeeded because Unix deletion requires write on the *parent directory*, not the file. Root-owned files in a developer-owned directory could be unlinked. Replaced by `root:developer 01775` (sticky + group-write): developer retains write access via the group bit but the sticky bit limits unlink to files the user owns.
- **`chattr +i` (immutable flag) on locked files:** would block deletion even by root, but requires `CAP_LINUX_IMMUTABLE` which Docker drops under `--no-new-privileges`. Unavailable.
- **Per-file ACLs:** `setfacl` allows fine-grained per-user deny entries without changing directory ownership. Rejected because `acl` is not guaranteed to be installed in the workspace image and adds a non-standard dependency.
- **Hidden content stored out-of-mount (like secrets), injected only at script runtime:** more robust (no UID/GID pinning) but the file stops being a normal in-place workspace file the user edits/views. Rejected in favour of in-place GID-gated files; the deployment constraint is acceptable.
- **Hidden + privileged combined ("blind execution" of a proprietary script):** rejected for simplicity — `[S]`/`[H]` are mutually exclusive.
- **One collapsed tag via precedence (`H > S > R > RW`):** rejected in favour of three explicit, independent tags so the agent never has to infer a state from the absence of another.

## Notes

- PRD: `doc/prd/accepted/prd-agent-privilege-model.md`
- Enforcement: `lib/infra/osLock.ts`, `lib/infra/permissionStore.ts`, `lib/infra/privilegeStore.ts`, `lib/infra/hiddenStore.ts`
- Tools & tags: `lib/agent/tools/tags.ts`, `lib/agent/tools/{fileRead,fileWrite,fileEdit,listDirectory,glob,execCommand}.ts`
- Routes: `app/api/workspaces/[id]/{permissions,privileged-scripts,hidden,files}/route.ts`
- Container & reconcile: `lib/infra/containerManager.ts`, `Dockerfile.workspace`
- Supersedes the earlier draft ADR *File lock mechanism + trusted scripts*.

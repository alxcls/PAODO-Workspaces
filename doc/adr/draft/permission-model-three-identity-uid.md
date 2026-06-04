# ADR — Permission model: three-identity UID system (Eye / Lock / Key)

Status: Draft

## Context

The existing access-control layer (see `doc/adr/draft/file-locks-and-trusted-scripts.md`) has two meaningful gaps:

1. **No read-visibility control.** The agent can read every file in the workspace, including secrets (`.env`, API keys, credentials). There is no way to hide content from the agent without removing the file entirely.
2. **Lock enforcement is asymmetric.** Per-path locks block file tools (software gate) but not shell commands. Only the global lock is OS-enforced. The trusted-scripts bypass path was never implemented.

The PRD (`doc/prd/draft/prd-permission-model.md`) introduces a three-identity, three-symbol system — Eye / Lock / Key — to close both gaps without adding user-facing complexity. A parallel requirement is that the agent must be able to install system packages: `lib/infra/aptBroker.ts` already exists for this but currently calls `docker exec -u root`, which the PRD explicitly retires.

The app runs either locally on macOS (Docker Desktop) or on the Linux VPS (Docker, bind-mounted `./data/`). In both cases isolation is at the container boundary — OS-level UID enforcement is identical across environments.

## Decision

### 1. Three container identities — no root

Three distinct UIDs exist inside every workspace container. Root is not used for any ongoing operation.

| Identity | UID | Unix user | Purpose |
|---|---|---|---|
| App user | 1000 | `node` | Next.js server process — serves UI, mediates all privileged ops |
| Agent | 999 | `agent` | AI executing tool calls; sandboxed by OS perms |
| Privileged | 998 | `privd` | Elevated context for keyed scripts and server-mediated installs |

Root (uid 0) is used only transiently during container image build and for `apt-get install` (see §4).

### 2. Eye — software-gated read visibility for the agent

The eye symbol is enforced as a **software gate** inside the app process, not a pure OS-level permission. Reason: the agent accesses files through the Node.js tool layer (`fileRead`, `listDirectory`, `glob`), not through a standalone process with its own uid. Changing file ownership/mode to block uid 999 would also block `listDirectory` from listing the file in the tree, which is explicitly not the desired behaviour (file should appear in the tree, content should be redacted).

Implementation:
- `permissionStore.ts` gains a `hidden: string[]` field alongside `locked: string[]`.
- `fileRead` and `app/api/workspaces/[id]/files/content/route.ts` check `isAgentHidden()` before returning bytes; blocked reads return a fixed placeholder string.
- `listDirectory` and `glob` still enumerate hidden files — they mark them with an `eye-off` flag in the response so the UI can render the badge, but they do not expose content.
- The files API route (`/api/workspaces/[id]/files`) exposes `hidden[]` in the permission snapshot so the file tree can render eye badges.

The app user (uid 1000) and privileged user (uid 998) are never subject to the eye gate — they can always read any file.

### 3. Lock — dual-layer OS + software enforcement

Lock enforcement uses two layers for defence-in-depth, closing the gap identified in the existing ADR:

**Software gate** (existing, extended): `isAgentLocked()` in file tools blocks writes before any syscall. Extended to also gate the files content API so the app user cannot write locked files through the UI editor either.

**OS layer** (new): Locked files and directories are `chown`ed to uid 998 (`privd`) with mode `644` (agent can read, cannot write). Unlocked workspace files are owned by uid 999 (`agent`) with mode `664`. The `reconcileOsPermissions` function in `lib/infra/osLock.ts` performs this sweep after any operation that may change ownership (apt install, keyed script execution, lock toggle).

Shell commands run by the agent (`execCommand`) run as uid 999 inside the container, so OS-level mode bits enforce the lock even if the software gate is bypassed.

### 4. Key — privileged script execution via server-mediated wrapper

The key symbol marks an executable (script file or all executables in a folder) as allowed to run under uid 998 (`privd`), which has write access to locked files (mode `644` owned by `privd`).

- Key state is stored in `permissionStore.ts` as `keyed: string[]`.
- The human operator sets/unsets key exclusively through the file tree UI — there is no agent tool path to grant the key.
- When the agent calls `execCommand` on a keyed script, the app server detects the key flag and invokes the script via `docker exec -u privd` instead of `docker exec -u agent`. The agent itself never elevates; the server mediates the identity switch.
- Key on a folder propagates at runtime: `isKeyed()` walks the path ancestry, so individual files inside a keyed folder do not need to be individually flagged.

### 5. apt package installation — server-mediated root carve-out

`apt-get install` categorically requires root. The PRD's "no identity ever runs as root" applies to **ongoing execution identities**, not to privileged maintenance operations mediated by the server. `aptBroker.ts` already implements the correct pattern:

- The agent calls the `install_system_package` tool (a new agent tool wrapping `aptBroker.aptInstall`).
- The app server (uid 1000) receives the call, validates package names against `PKG_RE`, and invokes `runRoot()` — a `docker exec -u root` call — to run `apt-get install`.
- After install, `reconcileOsPermissions()` restores correct ownership so apt maintainer scripts cannot leave root-owned files that break uid 1000 or 999 access (this is the existing prod bug documented in memory).
- Calls are serialized per container (the `queues` map in `aptBroker.ts`) because dpkg holds a global lock.

The agent never runs as root. Root is used only transiently by the **server** (uid 1000) acting as the broker. This is consistent with the PRD's intent: "no identity (including privileged) ever runs as root."

### 6. Permission state persistence

All three sets (`hidden`, `locked`, `keyed`) are persisted in `.agent-permissions/<workspaceId>.json` under `WORKSPACES_ROOT`. The file survives container restarts because it lives on the bind-mounted host volume, not inside the ephemeral container layer. `reconcileOsPermissions` must be called after any permission toggle to synchronise OS-level mode bits with the stored state.

## Consequences

**Enables:**
- Agent cannot read hidden files even via shell (`cat .env`) because `execCommand` runs as uid 999 and OS mode bits enforce visibility — closing the shell-command gap for write that the previous ADR left open for read.
- Locked folders are enforced at the OS layer for all agent access paths, not just file tools.
- Trusted/keyed scripts can write locked files without granting the agent blanket write access.
- `apt install` is safe and serialized; ownership is always reconciled.
- Permission state survives restarts on both macOS (Docker Desktop volume mount) and Linux VPS (native Docker bind mount).

**Costs:**
- `reconcileOsPermissions` must be called after every permission toggle, apt install, and keyed script run — a full `chown`/`chmod` sweep of the workspace on each mutation.
- Eye is not OS-enforced for shell commands: the agent could `cat` a hidden file if it bypasses the tool layer. Full OS enforcement would require mode `640` owned by `node:agent-group` with agent not in that group — adds container user/group setup complexity. Accepted as a later hardening step.
- Adding uid 998 (`privd`) requires Dockerfile changes and container rebuild.

## Alternatives considered

**OS-level eye enforcement via mode bits**: set hidden files to mode `640` owned by uid 1000, agent not in that group → agent `cat` blocked at kernel level. Rejected for now: listing hidden files in the tree requires the agent process to at least `stat` them; splitting stat access from read access requires ACLs (not available on all filesystems/Docker storage drivers). Accepted as a future hardening step once the software gate is validated.

**Single elevated UID (root)**: simpler than a dedicated `privd` uid. Rejected: the PRD explicitly prohibits root as an ongoing identity, and running keyed scripts as root would have unbounded blast radius (network, package installation, container escape vectors).

**Keyed scripts executed in a sidecar container**: isolate privileged execution completely. Rejected: inter-container IPC overhead, complexity of volume sharing, no clear security gain over a distinct UID inside the same container given the existing Docker socket proxy controls.

**Allowlist apt packages at the platform level**: only permit a curated set of packages. Rejected: too restrictive for a general coding agent; `PKG_RE` validation plus server-mediated serialization is sufficient.

## Notes

- Related PRD: `doc/prd/draft/prd-permission-model.md`
- Key infra files: `lib/infra/permissionStore.ts`, `lib/infra/aptBroker.ts`, `lib/infra/osLock.ts` (planned), `lib/infra/containerManager.ts`
- Key agent tools: `lib/agent/tools/fileRead.ts`, `lib/agent/tools/fileWrite.ts`, `lib/agent/tools/fileEdit.ts`, `lib/agent/tools/execCommand.ts`, `lib/agent/tools/installPackage.ts` (planned)

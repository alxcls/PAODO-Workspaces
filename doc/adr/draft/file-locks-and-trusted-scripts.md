# ADR — File lock mechanism + trusted scripts

Status: Accepted (lock) / Draft (trusted scripts)

## Context

The agent has two write surfaces sharing the same bind-mounted filesystem:
- **File tools** (`fileWrite`, `fileEdit`): in-process JS with path traversal checks and edit validation.
- **Shell commands** (`execCommand`): run inside a per-workspace Docker container for resource limits and process isolation.

## Decision

Two lock granularities in `lib/infra/permissionStore.ts` (JSON under `./data/.agent-permissions/`):

**Per-path locks** (`locked[]`): mark individual files/directories read-only for file tools only. Checked by `isAgentLocked()` before any write; ancestor directories cover all descendants. No OS-level enforcement — shell commands bypass this.

**Global workspace lock** (`globalLock`): blocks all writes via two mechanisms:
- File tools: `isAgentLocked()` returns true for any path.
- Shell commands: Docker runs with `-u agent` (UID 999, no write perms to `/workspace`) — OS-level, not bypassable by a JS bug.

**Trusted scripts (not yet implemented):** crown toggle in the UI to allow specific scripts to write locked files. Stored in `PermStore`, set exclusively via UI.

## Key trade-offs

- Per-path locks protect file tools only — shell commands can still write through them. Accepted limitation.
- Global lock is strongly enforced via Docker user-switching. The asymmetry is intentional.
- Trusted scripts introduce a bypass path requiring runtime enforcement.

## Alternatives rejected

- `chmod` on bind-mounted files for per-path enforcement: filesystem state drifts independently of app state.
- Route file tools through Docker: subprocess overhead on every op, no locking benefit.
- Shell commands in-process: removes resource/process isolation. Hard requirement.

## References

- Lock enforcement: `lib/infra/permissionStore.ts`, `lib/agent/tools/fileEdit.ts`, `lib/agent/tools/fileWrite.ts`, `lib/agent/tools/execCommand.ts`
- Container config: `lib/infra/containerManager.ts`
- PRDs: `doc/prd/accepted/prd-lock-mechanism.md`, `doc/prd/accepted/prd-trusted-scripts.md`

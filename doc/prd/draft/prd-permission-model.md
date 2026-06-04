# PRD — Permission Model (Eye / Lock / Key)

**Status:** Draft  
**Author:** @alxcls  
**Related:** [prd-trusted-scripts.md](prd-trusted-scripts.md), [prd-opaque-files.md](prd-opaque-files.md)

---

## Problem

Every agent command today runs as root inside the workspace container. There is no meaningful per-file access control: the agent can read anything, write anything, and execute anything. Users have no way to protect sensitive files from the agent short of globally locking the entire workspace.

## Goals

Introduce a three-identity, three-symbol permission system displayed in the file tree — modelled on the familiar Linux `rwx` bits but expressed visually so non-technical users can reason about it at a glance.

**Three identities**

All three are Linux process identities (UIDs) inside the workspace container. No identity is root. The human operator is not one of them — they interact through the UI and control which files carry which symbols, but they have no execution identity in the container.

| Identity | What it is |
|---|---|
| App user | The platform server process (uid 1000, `node`) |
| Agent | The AI executing commands in the workspace container (uid 999, `agent`) |
| Privileged | An elevated execution context — the UID that keyed scripts run under, granting them write access to locked files |

**Three symbols**

### Eye — visibility

Controls whether an identity can see the file content.

| Identity | Eye on | Eye off |
|---|---|---|
| App user | can read the file | — |
| Agent | — | cannot read the file content |
| Privileged | can read the file | — |

When the eye is off for the agent, the file exists in the tree but its content is never returned to the agent — reads return empty or a redacted placeholder.

### Lock — write protection

Controls whether an identity can modify the file or folder.

| Identity | Locked | Unlocked |
|---|---|---|
| App user | cannot edit the file or folder | — |
| Agent | cannot edit the file; cannot edit any file inside a locked folder | — |
| Privileged | can edit the file | — |

The lock on a folder is recursive for the agent: it cannot modify any file inside, even if those files are individually unlocked.

### Key — elevated execution

Grants an executable file (any script: `.py`, `.ts`, `.sh`, …) the privilege to modify and execute other files, overriding the lock.

- Set on a file: that specific script can write to locked files and invoke other executables.
- Set on a folder: every executable file inside inherits the key.
- Only the privileged user can grant or revoke the key — the agent cannot.

## Non-goals

- The key does not grant network access or package installation rights.
- No identity (including privileged) ever runs as root — root is retired.
- The permission UI is not a general ACL editor; each symbol is a single toggle, not a bitmask.

## User stories

> As a citizen developer, I want to hide a `.env` file from the agent so it can work in my project without ever seeing my API keys.

> As a citizen developer, I want to lock a `config/` folder so the agent cannot touch any of its files, but my `seed.ts` script (keyed) can still regenerate them — it runs as the privileged identity and is therefore allowed through the lock.

> As a citizen developer, I want to see at a glance — from the file tree — exactly what the agent is and isn't allowed to do with each file, without reading any documentation.

## Requirements

### Must have

- Three identities are enforced at the OS level inside the workspace container (distinct UIDs, no root).
- Eye, lock, and key are toggleable from the file tree UI as icon badges on each file and folder.
- The agent receives a clear error when it attempts to read a hidden file or write a locked file.
- The key can only be granted or revoked by the human operator through the UI — there is no agent tool or prompt path to set it.
- Key on a folder propagates to all executables inside at runtime (no need to badge each file individually).
- The agent's system prompt describes all three symbols so it understands and communicates restrictions correctly.
- Permission state survives server restarts.
- When the agent is blocked, it tells the user which symbol is preventing the action and what the user would need to change.
- Bulk-apply eye or lock to an entire folder from the folder context menu.

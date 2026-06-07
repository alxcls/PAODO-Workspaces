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
| App user | The UI editor proxy (uid 1002, `appuser`); member of the `access` group |
| Agent | The AI executing commands in the workspace container (uid 999, `agent`) |
| Privileged | An elevated execution context — the UID that keyed scripts run under (uid 998, `privd`), granting them write access to locked files |

**Three symbols — assigned by file type**

Eye and Lock/Key are mutually exclusive by file type:

| Symbol | Applies to | Purpose |
|---|---|---|
| Eye | Non-executable files (data, config, `.env`, …) | Hide content from the agent |
| Lock | Executable files (scripts: `.py`, `.ts`, `.sh`, …) | Prevent the agent from modifying scripts |
| Key | Executable files only | Run the script as the privileged identity |

### Eye — visibility (non-executables only)

When the eye is off the agent cannot read the file. It still sees the filename in the tree and can write to it (e.g. append config). Eye cannot be set on executable scripts: the kernel must read a script to execute it, so hiding one would silently break execution.

| Identity | Eye on | Eye off |
|---|---|---|
| App user | can read | can read |
| Agent | can read | cannot read |
| Privileged | can read | can read |

### Lock — write protection (executables only)

Prevents the agent from modifying a script before it runs as privd. The lock is OS-enforced: even raw shell commands from the agent cannot write past it.

| Identity | Locked | Unlocked |
|---|---|---|
| App user | cannot edit | can edit |
| Agent | cannot edit | can edit |
| Privileged | can edit | can edit |

The lock on a folder is recursive for the agent: it cannot modify any executable inside, even if those files are individually unlocked.

### Key — elevated execution (executables only)

Grants a script the privilege to modify locked files when run as privd. **Setting the key automatically applies the lock** — a keyed script is always write-protected from the agent; only privd can execute it.

- Set on a file: that specific script runs as privd and can write to locked files.
- Set on a folder: every executable inside inherits the key.
- Only the operator can grant or revoke the key via the UI — the agent cannot.

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
- Eye, lock, and key are toggleable from the file tree UI as icon badges; eye is shown only on non-executables, lock/key only on executables.
- The agent receives a clear error when it attempts to read a hidden file or write a locked file.
- The key can only be granted or revoked by the human operator through the UI — there is no agent tool or prompt path to set it.
- Key on a folder propagates to all executables inside at runtime (no need to badge each file individually).
- The agent's system prompt describes all three symbols so it understands and communicates restrictions correctly.
- Permission state survives server restarts.
- When the agent is blocked, it tells the user which symbol is preventing the action and what the user would need to change.
- Bulk-apply eye or lock to an entire folder from the folder context menu.

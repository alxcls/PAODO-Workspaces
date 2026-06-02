# PRD — Trusted Scripts (Secured)

**Status:** Draft  
**Author:** @alxcls  
**Related:** [prd-lock-mechanism.md](prd-lock-mechanism.md), [agent-lock-bypass.md](../agent-lock-bypass.md)

---

## Problem

The lock mechanism prevents the agent from directly editing locked files. However, the agent can bypass this by writing a new script and running it via the shell — the script executes at the OS level where the lock does not exist. This means a locked file gives the user a false sense of protection when the workspace is not globally locked.

The user cannot simply block all script execution, because some scripts are the *intended* way to modify locked files (e.g. a `randomize.js` that regenerates a locked `values.json`). The lock needs to distinguish between scripts the user trusts and scripts the agent invents.

## Goals

- Users can mark a specific script as trusted, meaning it is allowed to write to locked files
- The agent is aware that it cannot grant trust to a script — only the user can
- The agent understands which scripts are trusted and which are not, and explains the restriction clearly when it hits one
- The key icon is the consistent visual signal for trusted scripts across the file tree and agent output

## Non-goals

- Trusted status does not grant any other elevated privilege — a trusted script cannot install packages, modify system config, or touch files outside the workspace
- Trusted status does not bypass the global workspace lock [R] — if the workspace is globally locked, even trusted scripts cannot run write commands
- The agent cannot read or list which scripts are trusted in order to plan a bypass strategy

## User stories

> As a citizen developer, I want to mark `randomize.js` as trusted so it can update my locked `values.json`, while the agent still cannot touch that file directly or through its own scripts.

> As a citizen developer, I want to see a key icon on trusted scripts in the file tree so I always know at a glance which scripts hold elevated access.

> As a citizen developer, I want the agent to tell me when it needs to modify a locked file and suggest I either unlock the file or trust an existing script, rather than silently failing or inventing a workaround.

> As a citizen developer, I want confidence that the agent can never self-grant trust — only my explicit action in the UI can produce a secured script.

## Requirements

### Must have

- A user can toggle trusted status on any script file from the file tree UI (key icon badge, same interaction pattern as the lock icon)
- Trusted status is set and unset exclusively through the UI — the agent has no tool or prompt path to set it
- When a script without trusted status attempts to write to a locked file at runtime, the write is blocked and the agent receives an error naming the locked file and explaining that only a user-trusted script (secured) can write to it
- The agent's system prompt describes the secured concept: trusted scripts are user-granted, the agent cannot grant trust, and the agent must not attempt to work around this by creating new scripts
- Trusted status survives server restarts
- The key badge is visible persistently in the file tree, not only on hover

### Nice to have

- Tooltip on the key badge: "Trusted script — can write to locked files. Only you can grant this."
- When the agent is blocked by a missing trust grant, it names the script it would have used and prompts the user to secure it if they agree

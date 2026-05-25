# PRD — Lock Mechanism

**Status:** Accepted  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md), [prd-api-access.md](prd-api-access.md)

---

## Problem

The agent has unrestricted write access to every file in a workspace by default except it's AGENTS.md. This is convenient for fully automated tasks, but dangerous when some files must not be touched — reference data the user hand-curated, or some scripts that need to be frozen, config files that should survive a refactor, or an entire workspace being reviewed. Without a way to restrict the agent, the user has to supervise every tool call that touches the filesystem.

## Goals

- Users can protect specific files or directories from agent writes without interrupting an ongoing agent run
- Users can put an entire workspace into a hardened read-only mode that also prevents the agent from installing packages or running write-oriented shell commands
- The agent is fully aware of lock state and explains the restriction to the user rather than silently failing or trying to work around it
- This mechanism is to allow harnessing the agent so it can run autonomously with peace of mind that certain files will not drift

## Non-goals

- Per-user or per-role permissions — a workspace has a single owner and a single permission state
- Read-protection (hiding file contents from the agent) — [R] only prevents writes
- Execution of scripts prevention, scripts are executable always
- Locking at the agent-run level (pausing or killing a run) — that is a separate concern

## User stories

> As a citizen developer, I want to mark my directory as read-only so the agent can analyse its contents but never overwrite or delete my source files.

> As a citizen developer, I want my workspace agent to be aware of which files and folders are read-only and whether the workspace is fully locked.

> As a citizen developer, I want the agent to tell me when it hits a lock instead of producing a confusing error, so I know exactly what to unlock to unblock it.

> As a citizen developer, I want to organise my workspace as a service for automating a task, some files need drift prevention so we have peace of mind that they will always produce the same output.

## Requirements

### Must have

- Per-path [R] blocks agent file writes including descendant paths of a locked directory
- Global [R] additionally drops the agent to a restricted OS user for all shell commands
- Lock state survives server restarts
- Agent error messages name the affected path and instruct the user to use the lock icon
- `chmod`, `chown`, `sudo`, `su` are unconditionally blocked so the agent cannot circumvent the permission model

### Nice to have

- Lock state visible in the file tree as a persistent badge (not just on hover)
- Bulk lock toggle at the workspace level (master lock button)

## Open questions

| Question | Owner | Status |
|----------|-------|--------|
| Right now in a unlocked workspace, if we lock the edit of a data.json folder the agent technically can create a new python script to edit data.json indirectly, we adress it through system prompt but we didn't find a way to harness it deterministically. | @alxcls | Addressed in [prd-trusted-scripts.md](prd-trusted-scripts.md), bypass documented in [agent-lock-bypass.md](../agent-lock-bypass.md) |

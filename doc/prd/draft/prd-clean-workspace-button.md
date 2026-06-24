# PRD — Rebuild Workspace Button

**Status:** Deferred — build only if we observe real breakage  
**Author:** alxcls  
**Related:** [VISION.md](../VISION.md), [prd-workspace-isolation.md](../accepted/prd-workspace-isolation.md), [prd-workspace-git-versioning.md](../accepted/prd-workspace-git-versioning.md)

---

> **Decision:** We are not building this yet. Workspace breakage is expected to be uncommon, and
> the underlying capability already exists in code (unused), so it's a fast add later. We will
> implement only if we actually see users or agents getting workspaces into a broken state.
> Until then, this PRD just records the plan.

## Problem

Sometimes a workspace stops behaving. The agent keeps saying it can't install something, or that a dependency it just set up "isn't found," or it gets stuck repeating the same error. The files are fine — it's the dependencies installed in the workspace that have gotten into a bad state, and right now there's no way to fix that.

Today the only option is to delete the whole workspace and start over, which also throws away the files, the history, and the API key. That's a heavy price for a problem the user didn't cause.

## Goals

- Give the user a single button that fixes a misbehaving workspace.
- Keep all files and folders exactly as they are.
- Clear out the installed dependencies and start them fresh, so whatever was broken is gone.

## Non-goals

- This is not for fixing the user's own files or undoing the agent's work — that's what version history (rollback) is for.
- It does not change anything outside the workspace (no emails, no external services).
- It is not a "uninstall this one thing." It's a clean slate for the installed dependencies, all at once.

## User stories

- As a user, when my workspace stops working I want one button that fixes it, without losing my work.
- As a user, I want to be told clearly that my files are safe before I press it.
- As a user, I don't want to understand *why* it broke — I just want it working again.

## Requirements

### Must have

- A **Rebuild workspace** button, available per workspace.
- Pressing it shows a short confirmation: *"This gives your workspace a fresh start. Your files and folders are kept. Dependencies the agent installed will be cleared."*
- After confirming, the workspace is rebuilt and ready to use again.
- Files, folders, history, and the API key are all kept untouched.

### Nice to have

- The agent offers the button automatically when it notices the workspace is stuck, instead of the user having to find it.
- A short note shown afterward: *"Done — your workspace is fresh. The agent will re-install any dependencies it needs as it works."*

## Decided

- **It's a button** (not agent-driven) — the user is in control and presses it themselves.
- **Name:** "Rebuild workspace."
- **Confirmation copy reassures about files** — important, since "rebuild" could otherwise sound like it wipes everything.

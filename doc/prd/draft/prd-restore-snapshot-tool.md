# PRD — Restore Snapshot Tool

**Status:** Deferred — not needed for v1  
**Author:** alxcls  
**Related:** [prd-workspace-git-versioning.md](prd-workspace-git-versioning.md), [prd-goal-anchored-loop.md](prd-goal-anchored-loop.md), [agent-loop.md](../../agent-loop.md)

> **Deferred.** The agent fixes forward (it can rewrite/delete its own changes) and the human has UI rollback, so an agent-facing restore tool isn't needed for v1. Revisit only if transcripts show the agent stuck in a bad state it can't cleanly edit out of. Versioning + human rollback live in [prd-workspace-git-versioning.md](prd-workspace-git-versioning.md).

---

## Problem

Workspace Versioning records a snapshot of the files each run (see [prd-workspace-git-versioning.md](prd-workspace-git-versioning.md)), and a user can roll back from the UI. But the **agent itself** has no way to roll back mid-run. When an attempt goes wrong — a failed critique, a broken edit — it can only pile more fixes on top of a bad state instead of returning to a known-good one. It also cannot reach the versioning history directly: that history is platform-owned and deliberately outside the agent's reach, so a workspace script (`execute_command`) cannot touch it.

## Approach

A single **runner-mediated loop tool, `restore_snapshot`**, that lets the agent revert the workspace files to a previous snapshot. Signal-only, like `compact_context`: the tool itself only carries the agent's intent; the **runner** performs the restore against the platform-owned versioning history, because the agent has no access to it.

This PRD owns **only the tool**. The snapshot/commit/diff machinery, the history store, and the UI rollback all live in [prd-workspace-git-versioning.md](prd-workspace-git-versioning.md).

## Goals

- Let the agent revert the workspace to a known-good snapshot during a run, then continue.
- Pair with the goal-anchored loop: on a red critique, restore and retry from clean state instead of stacking fixes.
- Keep the restore action platform-mediated so the agent can't tamper with the history itself.

## Non-goals

- Defining how snapshots are created, stored, listed, or diffed — that is the versioning PRD.
- Reversing side effects — restore puts **files** back; it cannot unsend an email, un-call an API, or undo external writes.
- Fine-grained (per-edit) restore in v1 — coarse, per-run granularity to start.
- Browsing/choosing arbitrary historical snapshots from the agent — v1 targets the last good snapshot only.

## User stories

- As the agent, after a failed attempt I want to restore the workspace to before it, so I retry from a clean state.
- As the agent, after a red critique I want to discard my changes and try a different approach without leftover partial edits.
- As a workspace owner, I want the agent's restores recorded in history like any other change, so the rollback is itself auditable.

## Requirements

### Must have

- **`restore_snapshot` tool (signal-only)** in the ReAct toolset. Args: a target (default: the **last result snapshot** / pre-run baseline of the current run). Returns a short ack describing what was restored.
- **Runner-mediated execution** — the runner performs the restore against the platform versioning history; the tool has no direct access. Mirrors the `compact_context` signal pattern.
- **Coarse granularity** — restore to a run-boundary snapshot, not an arbitrary mid-run point.
- **Files only** — the tool's ack states plainly that external side effects are not reverted.
- **Auditable** — a restore is itself a recorded change in the versioning history (not a silent rewrite).
- **No collision with the workspace's own repo** — restore operates only on the platform versioning history; it must not touch or reset a workspace's own `.git` / GitHub working state (mechanism owned by the versioning PRD).

### Nice to have

- Let the agent restore to a **named earlier snapshot** (requires snapshot listing exposed to the loop — depends on the versioning PRD).
- A `restore_verdict` / event surfaced to the UI so a restore is visible in the live stream.
- Per-workspace toggle to disable agent-initiated restore (owner keeps rollback manual).

## Dependencies

- **[prd-workspace-git-versioning.md](prd-workspace-git-versioning.md)** — provides the snapshots this tool restores from and the platform-owned restore mechanism. This PRD is a consumer; it adds no versioning logic of its own.

## Open questions

- Default target: always the current run's pre-run baseline, or the last *result* snapshot?
- Should agent-initiated restore be on by default, or opt-in per workspace?

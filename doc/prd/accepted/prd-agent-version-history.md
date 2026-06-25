# PRD — Agent Version History

**Status:** Accepted
**Author:** alxcls
**Related:** [prd-workspace-git-versioning.md](prd-workspace-git-versioning.md)

---

## Problem

The workspace already keeps a snapshot of every run, and a person can browse and roll them back from the History panel. But the agent itself was blind to this. It could not see what changed across earlier runs, and it had no way to undo its own work and retry. The agent needs its own safe way to look back and to roll back.

## Goals

- Let the agent review what changed in earlier runs before redoing work.
- Let the agent undo its own changes and retry from a clean state during a loop.
- Keep the agent on the platform's snapshot history, never on the workspace's own `git`.

## Non-goals

- A second copy of the version history — the agent and the UI read the same snapshots.
- Undoing things that already left the workspace (sent emails, API calls). Files only.
- Letting the agent reach the platform's history files directly; it acts only through these tools.

## User stories

- As the agent, I can list snapshots with a short summary of what each one changed, optionally ask for just the last N, and see which one the workspace is currently on.
- As the agent, I can open one snapshot to read exactly what changed, page through a large change, or narrow to a single file.
- As the agent, I can roll the workspace files back to an earlier snapshot and try again.

## Requirements

### Must have

- A **browse** tool (`workspace_history`):
  - With no snapshot given, lists snapshots, each with its age, file count, and a short per-file change summary.
  - Supports an optional `last` argument to cap the list to the newest N snapshots when the history is large.
  - Marks the snapshot the workspace is currently on as `(current)`.
  - Given a snapshot, shows what changed in it. Large changes are paged and the tool says how much was left out; the agent can ask for the next page or narrow to one file.
- A **roll-back** tool (`workspace_restore`):
  - Given a snapshot from `workspace_history`, rolls the files back to it.
  - Always tells the agent it only undoes files, not external side effects.
  - Snapshots made after the restored point stay in the history, so nothing is lost and the move can be reversed.
- The agent is told, in its instructions, to use these tools for history and roll-back and never the workspace's own `git`.
- Both tools are kept lean so they cost few tokens — short summaries first, full detail only on request.

### Nice to have

- A UI signal when the agent rolls back, so a watching user sees it happen. *(The system already announces the roll-back internally; no panel shows it yet.)*
- A per-workspace switch to turn agent roll-back off. *(Currently always on.)*

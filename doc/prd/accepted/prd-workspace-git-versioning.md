# PRD — Workspace Git Versioning

**Status:** Accepted
**Author:** alxcls

---

## Problem

Agent file edits are irreversible. There is no way to roll back a bad result or browse what happened across runs.

## Goals

- Auto-snapshot each workspace
- Let the user browse run history
- Let the user roll back to any previous snapshot

## Non-goals

- Remote push / cloud backup
- Branch management or merge UI
- Versioning of non-file state (conversation history, permissions)

## User stories

- As a user, I can browse the run history as a list of snapshots
- As a user, I can roll back the workspace to any previous snapshot in one click

## Requirements

### Must have

- A new workspace gets an initial snapshot when it is created.
- Each agent run produces exactly two snapshots: one before the run starts (labelled with the prompt) and one after it ends (labelled `run <n>`). A run that changes nothing produces no end snapshot.
- The end snapshot is captured on every outcome — normal completion, hitting the iteration limit, user abort, or error.
- User-driven file changes outside a run — saving, deleting, or uploading files — each produce a snapshot too.
- Snapshots capture every file in the workspace, including files the user or agent would normally ignore.
- A snapshot failure never blocks the action that triggered it: the run, save, upload, or workspace creation still succeeds.
- The workspace UI has a **History** panel listing every snapshot, newest first, marking the one the workspace is currently at.
- Clicking a snapshot rolls the whole workspace back to that state. Snapshots made after the one restored stay in the list, so the user can jump forward again.
- Deleting a workspace permanently removes its version history.

### Nice to have

- Show what changed between two snapshots as a diff in the UI.
- Show each snapshot's label in the History panel, not just its time.
- Per-file history accessible from the file tree.

# PRD — Workspace Git Versioning

**Status:** Draft  
**Author:** alxcls  

---

## Problem

Agent file edits are irreversible. There is no way to see what changed during a run, roll back a bad result, or audit history across runs.

## Goals

- Auto-snapshot each workspace via an embedded git repo
- Surface per-run diffs in the UI
- Enable one-click rollback to any previous run

## Non-goals

- Remote push / cloud backup
- Branch management or merge UI
- Versioning of non-file state (conversation history, permissions)

## User stories

- As a user, after an agent run I can see a diff of every file it touched
- As a user, I can roll back the workspace to the state before any previous run
- As a user, I can browse the run history as a commit log

## Requirements

### Must have

- `createWorkspace` runs `git init` + initial commit
- At the start of each `runAgent` call: create a snapshot commit (`pre-run: <user prompt truncated>`)
- After each iteration's `Promise.all` settles: one `git add <touched files> && git commit` with the tool names + files as the message — no per-tool-call commits (avoids index lock contention)
- `GET /api/workspaces/:id/history` — returns `git log` as JSON (sha, message, timestamp)
- `GET /api/workspaces/:id/diff?from=<sha>&to=<sha>` — returns unified diff
- `POST /api/workspaces/:id/restore` body `{ sha }` — hard resets workspace to that commit
- Diff viewer panel in the workspace UI, shown after each run completes

### Nice to have

- Run-level tags in git (e.g. `run/3`) for easy range diffs
- `.gitignore` pre-seeded in new workspaces (node_modules, __pycache__, etc.)
- Diff accessible inline in the file tree (per-file history)

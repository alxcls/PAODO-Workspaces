# PRD — Live Workspace File & Folder Updates

**Status:** Shipped  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md), [prd-file-visualization.md](prd-file-visualization.md)

---

## Problem

When the agent writes, edits, or deletes files, the browser UI has no way to know. The file tree shows a stale snapshot and the open file displays outdated content. Users must manually refresh the page — a significant friction point when supervising an agent that is continuously producing or modifying files.

---

## Goals

- The file tree reflects new and deleted files without user intervention while the agent is running.
- The open file in the viewer reloads automatically when the agent modifies it.
- Markdown previews refresh automatically so users see up-to-date output.
- User edits in progress are never silently overwritten by agent writes.

---

## Non-goals

- Collaborative multi-user editing.
- Conflict resolution UI between simultaneous user and agent edits.

---

## User stories

**Story 1 — User monitors agent file output in real time**  
As a citizen developer watching the agent generate files, I see new entries appear in the file tree as the agent creates them — I do not need to refresh the page.

**Story 2 — User reads a file the agent is actively updating**  
As a citizen developer with `report.md` open, when the agent appends a new section, the viewer silently reloads and shows the updated content within seconds.

**Story 3 — User edits while the agent writes**  
As a citizen developer with unsaved local edits, incoming agent file changes do not overwrite my work — the reload is suppressed until I save or discard.

**Story 4 — Agent deletes the open file**
As a citizen developer with a file open in the viewer, if the agent deletes it, the viewer closes automatically rather than showing a stale or errored state.

---

## Requirements

### Must have

- File tree updates after each agent turn completes.
- Open file content reloads automatically when the agent modifies it, with no action required from the user.
- The Markdown preview refreshes when its open file changes.
- Reloads are suppressed while the user has unsaved edits in the viewer.
- If the open file is deleted by the agent, the viewer closes.

### Nice to have

- File tree updates mid-turn (as files are created), not only at end of turn.
- WebSocket reconnect with backoff so the live feed survives server restarts.

---

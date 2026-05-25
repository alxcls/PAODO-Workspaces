# PRD — Live Workspace File & Folder Updates

**Status:** Accepted  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md), [prd-file-visualization.md](prd-file-visualization.md)

---

## Problem

When the agent writes, edits, or deletes files, the browser UI has no way to know. The file tree shows a stale snapshot and the open file displays outdated content. Users must manually refresh the page — a significant friction point when supervising an agent that is continuously producing or modifying files.

---

## Goals

- The file tree reflects new and deleted files without user intervention while the agent is running.
- The open file in the viewer reloads automatically when the agent modifies it.
- Rich previews (HTML, JSON, Markdown) refresh automatically so users see up-to-date output.
- User edits in progress are never silently overwritten by agent writes.

---

## Non-goals

- Collaborative multi-user editing.
- Conflict resolution UI between simultaneous user and agent edits.

---

## User stories

**Story 1 — User monitors agent file output in real time**  
As a user watching the agent generate files, I see new entries appear in the file tree as the agent creates them — I do not need to refresh the page.

**Story 2 — User reads a file the agent is actively updating**  
As a user with `report.md` open, when the agent appends a new section, the viewer silently reloads and shows the updated content within seconds.

**Story 3 — User edits while the agent writes**  
As a user with unsaved local edits, incoming agent file changes do not overwrite my work — the reload is suppressed until I save or discard.

**Story 4 — User views an HTML dashboard the agent refreshed**  
As a user watching an agent-generated HTML page in preview mode, when the agent updates a linked asset, the preview refreshes without any user action.

**Story 5 — Agent deletes the open file**  
As a user with a file open in the viewer, if the agent deletes it, the viewer closes automatically rather than showing a stale or errored state.

---

## Requirements

### Must have

- File tree updates after each agent turn completes.
- Open file content reloads automatically when the agent modifies it, with no action required from the user.
- Rich previews (HTML iframe, JSON graph, Markdown render) refresh when the underlying file or its assets change.
- Reloads are suppressed while the user has unsaved edits in the viewer.
- If the open file is deleted by the agent, the viewer closes.

### Nice to have

- File tree updates mid-turn (as files are created), not only at end of turn.
- WebSocket reconnect with backoff so the live feed survives server restarts.

---

## Open questions

| Question | Owner | Status |
|----------|-------|--------|
| Should the file tree refresh mid-turn, not only at end-of-turn? | alxcls | Open |
| Should self-write suppression also apply to agent tool writes? | alxcls | Open |

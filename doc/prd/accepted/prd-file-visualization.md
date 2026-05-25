# PRD — File Visualization

**Status:** Accepted  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md)

---

## Problem

The agent produces files that non-technical users are expected to read — formatted reports, data outputs, small HTML dashboards. Today every file opens as raw code, which is unreadable to anyone who is not a developer. A user receiving a summary report sees symbol-heavy markup instead of a clean document. A user checking live data sees a wall of text instead of a structured view.

The platform's value is that non-technical users can supervise and monitor a service and understand its outputs. That promise breaks the moment a non-technical user opens a file and cannot read it.

---

## Goals

- Markdown, JSON, and HTML/HTM files open in rendered view by default.
- Users can always switch to the raw code editor and back.
- The rendered output is visually clean — readable by someone who has never seen markdown or JSON syntax.

---

## Non-goals

---

## User stories

**Story 1 — Non-technical user reads an agent report**  
As a business user who asked the agent to summarize a dataset, when I click on `report.md` in the file tree, I immediately see a formatted document with headings, bold text, and bullet points — not raw markdown symbols.

**Story 2 — Non-technical user inspects agent data output**  
As a user reviewing an agent's JSON export, when I click on `results.json`, I see an interactive graph visualization of the data structure rather than a wall of raw JSON text.

**Story 3 — Non-technical user views an agent-generated web page**  
As a user who asked the agent to build an HTML dashboard, when I click on `index.html`, I see the rendered page inside the viewer rather than HTML source code.

**Story 4 — Technical user inspects raw source**  
As a developer reviewing what the agent wrote, I can switch any previewed file back to the code editor in one click, edit it, and save — the preview mode does not block editing.

---

## Requirements

### Must have

- **Auto-preview on open**: When a file with extension `.md`, `.json`, `.html`, or `.htm` is loaded in `FileViewer`, `showPreview` initializes to `true` instead of `false`.
- **Toggle remains available**: The existing Preview / Code button stays visible for all previewable files so users can switch modes freely.
- **Markdown**: Rendered via `react-markdown` + `remark-gfm` (already implemented). Output must apply basic typographic styles (headings, bold, lists, code blocks) so it looks like a document, not HTML dump.
- **JSON**: Rendered via `jsoncrack-react` (already implemented). Falls back to "File too big for preview" for oversized files (already handled).
- **HTML/HTM**: Rendered in the sandboxed iframe (already implemented). Relative assets load via the `/api/workspaces/[id]/serve/` route (already implemented).
- **Real-time refresh**: When the agent modifies a previewed file, the preview reloads automatically (already implemented via WebSocket + `previewKey` bump — must confirm behavior works in preview mode, not just editor mode).

### Nice to have

- **Remember per-type preference**: Store the user's last-chosen mode (preview vs. code) per file type in `localStorage` so repeat opens respect their preference.
- **Toggle label flip**: Relabel the toggle button "Source" when in preview mode and "Preview" when code mode, making the action clearer.
- **Markdown styles**: A lightweight stylesheet scoped to `.md-preview` that renders headings, tables, and code blocks with visual hierarchy (font sizes, spacing, borders) rather than bare browser defaults.

---

## Open questions

| Question | Owner | Status |
|----------|-------|--------|
| Did we enforce a tight enough security around the html visualizer ? | alxcls | Open |

# PRD — File Visualization

**Status:** Shipped  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md)

---

## Problem

The agent produces files that non-technical users are expected to read — especially formatted reports. Raw Markdown is difficult to read. A user receiving a summary report sees symbol-heavy markup instead of a clean document.

The platform's value is that non-technical users can supervise and monitor a service and understand its outputs. That promise breaks the moment a non-technical user opens a file and cannot read it.

---

## Goals

- Markdown files open in rendered view by default.
- Users can always switch to the raw code editor and back.
- The rendered output is visually clean — readable by someone who has never seen markdown or JSON syntax.

---

## Non-goals

---

## User stories

**Story 1 — Non-technical user reads an agent report**  
As a citizen developer who asked the agent to summarize a dataset, when I click on `report.md` in the file tree, I immediately see a formatted document with headings, bold text, and bullet points — not raw markdown symbols.

**Story 2 — User inspects agent data output**
As a citizen developer reviewing an agent's JSON export, when I click on `results.json`, I see it in the syntax-highlighted code editor.

**Story 3 — Technical user inspects raw source**
As a citizen developer reviewing what the agent wrote, I can switch a Markdown preview back to the code editor in one click, edit it, and save.

---

## Requirements

### Must have

- **Auto-preview on open**: When a Markdown file is loaded in `FileViewer`, `showPreview` initializes to `true` instead of `false`.
- **Toggle remains available**: The Preview / Code button stays visible for Markdown files so users can switch modes freely.
- **Markdown**: Rendered via `react-markdown` + `remark-gfm` (already implemented). Output must apply basic typographic styles (headings, bold, lists, code blocks) so it looks like a document, not HTML dump.
- **JSON**: Displayed in the syntax-highlighted code editor only — no graph/tree preview.
- **HTML/HTM and JSON**: Displayed in the syntax-highlighted code editor.
- **Real-time refresh**: When the agent modifies the open file, its content reloads automatically unless the user has unsaved edits.

### Nice to have

- **Remember per-type preference**: Store the user's last-chosen mode (preview vs. code) per file type in `localStorage` so repeat opens respect their preference.
- **Toggle label flip**: Relabel the toggle button "Source" when in preview mode and "Preview" when code mode, making the action clearer.
- **Markdown styles**: A lightweight stylesheet scoped to `.md-preview` that renders headings, tables, and code blocks with visual hierarchy (font sizes, spacing, borders) rather than bare browser defaults.

---

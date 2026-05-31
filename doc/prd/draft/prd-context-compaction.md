# PRD — Context Compaction

**Status:** Draft  
**Author:**  
**Related:** [prd-template.md](prd-template.md), VISION.md

---

## Problem

Long-running or active sessions accumulate conversation turns until the model's context window is exhausted. Currently the app has no way to trim or summarize old context, causing failures or degraded behavior for extended workflows.

## Goals

- Allow agents and users to maintain productive multi‑turn sessions longer than the model context window by summarizing older history into a compact representation.
- Preserve the important facts, decision rationale, and tool outputs needed for later reasoning while reducing token usage.
- Make compaction deterministic, auditable, and reversible for short-term recovery.

## Non-goals

- Replace full persistent conversation storage or build a large external vector DB.  
- Change core agent semantics: compaction should not alter the meaning of recent turns.  
- Support multi‑model compaction strategies (stick to existing OpenAI model for now).

## User stories

- As a developer using a workspace, I want long debugging or refactor sessions to keep working after hundreds of turns, so the agent doesn't lose context.
- As a user, I want the system to automatically reduce the size of older history when the token budget is exceeded so the agent continues functioning without manual intervention.
- As a user, I want to inspect a compacted summary for transparency so I can verify nothing important was lost.
- As an operator, I want compaction to persist lightweight summaries so restarts don't lose the distilled memory needed for future sessions.

## Requirements

### Must have

1. Automatic compaction trigger: when an in-memory conversation for a workspace exceeds a configurable token/turn threshold (default: 75% of model context or 200 turns), the system must compact older messages until the history size is back under a safe threshold (e.g. 50% of context).

2. Compaction operation:
   - Selects the oldest contiguous subset of turns (not touching the N most recent turns; default N=20) for summarization.
   - Calls the existing OpenAI model with a deterministic summarization prompt that produces a compact structured summary (plain text with short bullet list + metadata: time range, included turn ids, preserved facts).
   - Produces a single compacted entry that replaces the selected turns in the in-memory history.

3. Preservation of tool outputs and references: tool results (file reads, exec outputs) included in the selected range must be preserved in the summary as excerpts or references so the agent can rehydrate context if needed.

4. Persistence: store compacted summaries persistently under `data/<workspace>/compactions.json` (append-only), with the following fields per entry: id, createdAt, turnRange, tokenCountBefore, tokenCountAfter, summaryText. Conversation turns that remain in-memory continue to behave as today.

5. Audit & undo: provide an operation (backend endpoint) to expand the most recent compacted entry back into its original turns for the current session (best-effort; original turns stored encrypted on disk for short TTL, default 1 hour).

6. Safety & atomicity: compaction must be atomic with respect to the in‑memory history so the agent never observes a partially compacted state.

7. Telemetry/metrics: emit events for compaction start/finish, tokens saved, and failures to the existing logger so we can monitor effectiveness.

8. Minimal deps: reuse existing agent tooling and the global OpenAI configuration; do not introduce new external services.

### Nice to have

1. Manual compaction trigger from the workspace UI (button) that compacts older history on demand.
2. Per-workspace compaction settings (thresholds, N recent turns to keep, TTL for undo snapshots).
3. Human-readable compaction diff view in the UI to inspect what was summarized.
4. Periodic background compaction for idle workspaces.

## Acceptance criteria

- When running a long session that exceeds the configured token threshold, the system compacts older history and the agent continues responding without context-limit errors.
- Compacted summaries are written to `data/<workspace>/compactions.json` and include metadata described above.
- Rehydration (undo) restores recent turns for up to the configured TTL and the agent's behavior after undo matches the behavior pre-compaction for the restored segment.
- Logs include compaction start/finish and tokens saved.

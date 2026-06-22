# PRD — Context Compaction

**Status:** Shipped  
**Author:** @alxcls  
**Related:** [prd-agent-toolset.md](prd-agent-toolset.md), VISION.md

---

## Problem

Long-running or active sessions accumulate conversation turns until the model's context window is exhausted, causing failures or degraded behavior for extended workflows. Re-derivable tool output (file reads, search results, command logs) dominates that growth and compounds turn over turn.

## Goals

- Let the agent keep working on long, multi-unit jobs without exhausting the model's context window.
- Preserve the important facts, decisions, and current state needed to continue, while shedding bulky re-derivable output.
- Keep the message history valid for the active provider at all times — never orphan a tool call from its result.
- Stay provider-agnostic: compaction works whichever model the workspace is configured to use (OpenAI, Anthropic, or DeepSeek).

## Non-goals

- Automatic, size-triggered compaction — the agent decides when to compact (this is intentionally deferred; see Future work).
- Persisting compactions to disk or providing an undo/rehydrate path — history is in-memory only, so there is nothing durable to roll back to.
- A vector DB or external long-term memory store.
- Changing the meaning of recent turns — kept turns are preserved verbatim (or, for `light`, with only re-derivable tool output replaced by a placeholder).

## User stories

- As a citizen developer, I want long debugging or refactor sessions to keep working after many turns so the agent doesn't stall on a context-limit error.
- As a citizen developer running a long, repetitive job, I want the agent to trim its own context between units of work so it can finish all the work rather than running out of room partway.

## Requirements

### Must have

1. **Agent-driven trigger** — the agent compacts on demand by calling a `compact_context` tool. It chooses how aggressively, and every call carries a `next_step` note so the agent keeps the thread after trimming.

2. **Three levels:**
   - `light` — replace re-derivable tool output (file_read, glob, list_directory, http_get, execute_command) with a placeholder, in place. No LLM call, no deletion.
   - `medium` — summarize the older head into a single brief, keep a recent verbatim tail. The tail boundary snaps to an assistant-message boundary so kept tool calls retain their results.
   - `hard` — summarize the whole history into one brief: a clean slate.

3. **History stays provider-valid** — compaction only ever keeps or wipes complete turns, so every kept `tool_call` retains its `tool_result`. The tool is a signal only; the surgery runs in the agent runner *after* the requesting turn is committed, so nothing is orphaned.

4. **Provider-agnostic summarization** — the summary is one tool-less call to the workspace's configured chat model, not a hard-coded provider.

5. **Preserve the live checklist and signals** — todo_write, compact_context, and call_agent/list_agents output is never stripped.

6. **Telemetry** — compaction emits a log line with level and before/after message counts.

## Future work

- **Automatic (size-triggered) compaction**: compact when in-memory history exceeds a configurable fraction of the model's context, so a session that never compacts on its own still survives. On the roadmap.
- **Persisted compactions + auditable undo**: store summaries and short-TTL snapshots so a compaction can be inspected or rolled back. Explicitly out of scope while history is in-memory only.
- **Per-workspace compaction settings** (levels, recent-tail size) and a manual compaction button in the UI.

## Acceptance criteria

- The agent can call `compact_context` at any of the three levels mid-run and continue working without a context-limit error.
- After `medium`/`hard`, the history is `[system, summary(+next step), …]` with clean user→assistant alternation and no orphaned tool calls.
- `light` leaves structure unchanged, only replacing re-derivable tool output.
- Logs include a compaction line with level and before/after counts.

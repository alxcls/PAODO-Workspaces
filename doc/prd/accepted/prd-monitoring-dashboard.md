# PRD — Monitoring Dashboard

**Status:** Shipped  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md), [token-counter.md](../draft/token-counter.md), [prd-api-access.md](prd-api-access.md), [prd-agent-network.md](prd-agent-network.md)

---

## Problem

Once an agent run is over, users have little visibility into what actually happened. Token cost is part of it — there's no historical view of which workspaces consume the most over time — but the bigger gap is observability into the run itself: the prompts the agent was given, how it reasoned, the actions (tool calls) it took, and which of those succeeded or failed. Without that record, understanding or debugging a run is guesswork.

## Goals

- Users can see token usage per workspace accumulated over time
- Users can drill into individual agent sessions and their tool calls
- The dashboard survives server restarts and reflects all historical usage
- Users get immediate per-response token feedback directly in the chat UI
- Users can see the frozen USD cost of each completed run

## Non-goals

- Per-user or multi-tenant billing
- Quota enforcement

## User stories

> As a citizen developer, I want a dashboard showing cumulative token usage per workspace so I can identify which workspace is driving the most cost.

> As a citizen developer, I want to trace exactly what a run did — my input, the system prompt, the agent's reasoning, each tool call's success or failure, and the final answer — so I can understand and debug it.

> As a citizen developer, I want to see input and output token counts directly in the chat after each agent response so I can monitor cost in real time.

## Requirements

### Implemented

**Usage at a glance.** The dashboard lists recent runs across all workspaces with uncached input,
cached input, output, and frozen USD cost, so you can see where cost is going without leaving the
page.

**A trace of every run.** Open a run to see exactly what happened, in order: your input, the system prompt the agent ran under, its reasoning, each tool it executed (marked success or failure), and its final response. That turns "this run was expensive" into "here's why."

**Success or failure, at a glance.** Each tool execution carries a simple status — green for success, red for failure — so you can spot where a run went wrong and look at exactly what was sent and what came back.

**Usage as you work.** A small `↑ uncached  ↻ cached  ↓ output` counter appears on the final visible
answer for each complete agent loop. Cost stays in the dashboard rather than cluttering chat.

**Tool-level diagnosis.** Selecting a tool shows the same compact token breakdown for the LLM turn
that requested it. Parallel tools share their parent turn's measurements; the application never
invents per-tool token allocations.

**Kept across restarts.** Complete usage history survives server restarts in SQLite. The dashboard
loads a bounded recent window without deleting older database records.

### Nice to have (not implemented)

- A workspace filter on the dashboard, so you can focus on a single workspace's history (the data already supports it; the UI doesn't yet expose it)
- A breakdown by where the usage came from: direct chat vs. external API vs. one agent calling another
- A usage-over-time chart (daily or weekly trend per workspace)
- A per-workspace quota with a visual warning as you approach a limit
- Export of usage history as CSV

## Implementation notes

Writes live in `lib/usage/record.ts`, reads in `lib/usage/queries.ts`. A session is a row of its own:
`startUsageSession` opens it, `appendUsage` commits one `TurnRecord` and its ordered tool calls per
model turn, and `finishUsageSession` closes it with a terminal status. `recordTurnUsage` folds a
`turn_usage` event into a turn under a session/workspace context and is shared by all three call
sites (chat route, agent stream, nested skill calls) so the field mapping can't drift. Everything a
session owns — workspace, origin, input, prompt, status, error — is stored once on `sessions` rather
than repeated on every turn, so the list query joins the two. Lightweight list queries omit large
text and tool I/O; full detail is selected by `sessionId` only when its drawer opens. The in-chat counter
is driven by the `turn_usage` SSE events forwarded from the chat route: the hook sums every model
turn in the agent loop and shows one total on its final visible assistant output. Reopened
conversations derive the same aggregate from SQLite. The dashboard retains the underlying per-turn
records and tool-call detail.

SQLite stores provider facts with explicit semantics:
`input_tokens_total`, `input_tokens_cache_read`, `input_tokens_cache_write`,
`output_tokens_total`, and `output_tokens_reasoning`. Uncached input is never duplicated in storage;
both UIs derive it as `max(0, input total - cache read)`. Cache writes remain separate for accurate
cost calculation but count as uncached input in the compact presentation.

Conversation replay and execution history use separate authorities inside one application database.
Confidentiality of their persisted plaintext relies on network isolation rather than in-app auth —
see
[adr-conversation-and-execution-data-sqlite](../../adr/accepted/adr-conversation-and-execution-data-sqlite.md).

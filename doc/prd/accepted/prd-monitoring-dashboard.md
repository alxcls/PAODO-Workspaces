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

## Non-goals

- Per-user or multi-tenant billing
- Dollar cost estimates
- Quota enforcement

## User stories

> As a citizen developer, I want a dashboard showing cumulative token usage per workspace so I can identify which workspace is driving the most cost.

> As a citizen developer, I want to trace exactly what a run did — my input, the system prompt, the agent's reasoning, each tool call's success or failure, and the final answer — so I can understand and debug it.

> As a citizen developer, I want to see input and output token counts directly in the chat after each agent response so I can monitor cost in real time.

## Requirements

### Implemented

**Usage at a glance.** The dashboard lists recent runs across all workspaces, each with its token cost — sent, cached, and received — so you can see where cost is going without leaving the page.

**A trace of every run.** Open a run to see exactly what happened, in order: your input, the system prompt the agent ran under, its reasoning, each tool it executed (marked success or failure), and its final response. That turns "this run was expensive" into "here's why."

**Success or failure, at a glance.** Each tool execution carries a simple status — green for success, red for failure — so you can spot where a run went wrong and look at exactly what was sent and what came back.

**Cost as you work.** A small `↑ N  ↓ N` counter appears with each agent answer in the chat itself, so cost awareness is built into the normal workflow.

**Kept across restarts.** Usage history survives server restarts; the most recent runs stay available to inspect and older history is trimmed automatically so it never grows unbounded.

### Nice to have (not implemented)

- A workspace filter on the dashboard, so you can focus on a single workspace's history (the data already supports it; the UI doesn't yet expose it)
- A breakdown by where the usage came from: direct chat vs. external API vs. one agent calling another
- A usage-over-time chart (daily or weekly trend per workspace)
- A dollar-cost estimate per workspace
- A per-workspace quota with a visual warning as you approach a limit
- Export of usage history as CSV

## Implementation notes

The store (`lib/workspace/usageStore.ts`) appends one `TurnRecord` per model turn via `appendUsage`; `recordTurnUsage` folds a `turn_usage` event into the store under a session/workspace context and is shared by all three call sites (chat route, agent stream, nested skill calls) so the field mapping can't drift. Sessions are grouped client-side in the dashboard by `sessionId`, a UUID generated per HTTP request in the chat route. The in-chat counter is driven by the `turn_usage` SSE event forwarded from the chat route; the hook accumulates per-turn values and inserts a `usage` message into the message list on `done`.

Confidentiality of the persisted detail (prompts, reasoning, raw tool I/O, which may include secrets) relies on network isolation rather than in-app auth — see [adr-usage-detail-plaintext-storage](../../adr/accepted/adr-usage-detail-plaintext-storage.md).

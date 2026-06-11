# PRD — Monitoring Dashboard

**Status:** Accepted  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md), [token-counter.md](../draft/token-counter.md), [prd-api-access.md](prd-api-access.md), [prd-agent-network.md](prd-agent-network.md)

---

## Problem

Users have no way to see which workspaces consume the most tokens over time, or to compare usage across call types (direct chat, external API, inter-agent calls). Without a historical view, cost optimization is guesswork.

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

> As a self-hoster, I want a dashboard showing cumulative token usage per workspace so I can identify which workspace is driving the most cost.

> As a self-hoster, I want to drill into a session to see which tool calls were made so I can understand what drove a high-token run.

> As a self-hoster, I want to see input and output token counts directly in the chat after each agent response so I can monitor cost in real time.

## Requirements

### Implemented

- A dedicated dashboard page (`/dashboard`) accessible from the top navigation
- A session-level table: each row represents one agent run, showing workspace name, timestamp, input tokens, cached input tokens, and output tokens
- Expandable rows revealing every tool call (name + args + timestamp) made during that session
- Workspace filter sidebar to narrow the table to one or more workspaces
- Usage data persists in `.usage.json` across server restarts, capped at 5 000 records (oldest dropped when full)
- In-chat per-response token counter: a small `↑ N  ↓ N` line rendered just before each agent answer bubble, accumulating tokens across all model turns in that run

### Nice to have (not implemented)

- Usage breakdown by call type: direct UI chat vs external API vs inter-agent network call (would require a `callType` field in `TurnRecord` and in both `appendUsage` call sites)
- Usage chart over time (daily or weekly view per workspace)
- Dollar cost estimate per workspace (requires model price mapping)
- Usage quota per workspace with a visual warning when approaching a limit
- Export of usage data as CSV

## Implementation notes

The store (`lib/infra/usageStore.ts`) appends one `TurnRecord` per model turn. Sessions are grouped client-side in the dashboard by `sessionId`, a UUID generated per HTTP request in the chat route. The in-chat counter is driven by the `turn_usage` SSE event forwarded from the chat route; the hook accumulates per-turn values and inserts a `usage` message into the message list on `done`.

# PRD — Monitoring

**Status:** Draft  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md), [token-counter.md](token-counter.md), [prd-api-access.md](prd-api-access.md), [prd-agent-network.md](prd-agent-network.md)

---

## Problem

Users have no way to see which workspaces consume the most tokens over time, or to compare usage across call types (direct chat, external API, inter-agent calls). Without a historical view, cost optimization is guesswork.

## Goals

- Users can see total token usage per workspace accumulated over time
- Users can understand where usage is coming from (which call type)
- The dashboard survives server restarts and reflects all historical usage

## Non-goals

- Per-user or multi-tenant billing
- Real-time in-session counters (covered by the token-counter PRD)
- Dollar cost estimates
- Quota enforcement

## User stories

> As a self-hoster, I want a dashboard showing cumulative token usage per workspace so I can identify which workspace is driving the most cost.

> As a self-hoster, I want to see whether my tokens came from direct chat, an external API call, or an inter-agent call so I understand the source of my usage.

## Requirements

### Must have

- A dedicated dashboard page accessible from the top navigation
- A table listing every workspace with its total input and output token counts
- Each workspace row breaks down usage by call type: direct UI, external API, inter-agent network
- Usage data persists across server restarts and accumulates over time

### Nice to have

- Usage chart over time (daily or weekly view per workspace)
- Dollar cost estimate per workspace (requires model price mapping)
- Usage quota per workspace with a visual warning when approaching a limit
- Export of usage data as CSV

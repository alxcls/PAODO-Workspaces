# PRD — Token Counter

**Status:** Draft  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md), [monitoring.md](monitoring.md)

---

## Problem

While the agent is running, users have no indication of how many tokens are being consumed. A run that loops many times — because the task is complex or the context is large — looks identical to a simple one until the API bill arrives.

## Goals

- Users can see token consumption grow in real time as the agent loops
- The counter is always visible without leaving the workspace view

## Non-goals

- Historical data — this counter covers the current session only
- Dollar cost estimates
- Per-tool or per-message breakdown

## User stories

> As a self-hoster, I want to see input and output token counts update live as the agent works so I can stop a run early if it is consuming more than expected.

## Requirements

### Must have

- The workspace UI shows a persistent token counter displaying total input tokens (↑) and output tokens (↓) consumed since the session started, formatted in K (e.g. "↑ 12.3K  ↓ 4.1K")
- The counter updates after each agent loop iteration — not only when the full turn ends
- The counter resets when the user starts a new session (page load or reconnect)

### Nice to have

- Per-turn token count shown inline in the chat (e.g. a small annotation under each assistant response showing tokens used for that specific turn)
- Visual highlight or warning when the session total exceeds a configurable threshold

## Open questions

| Question | Owner | Status |
|----------|-------|--------|
| Where exactly in the workspace UI should the counter appear? | @alxcls | Open |
| Should the counter also show per-turn stats or a running total only? | @alxcls | Open |

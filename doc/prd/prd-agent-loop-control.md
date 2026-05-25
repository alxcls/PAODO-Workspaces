# PRD — Agent Loop Control

**Status:** Implemented  
**Author:** alxcls  
**Related:** [VISION.md](../VISION.md), [agent-loop.md](../agent-loop.md)

---

## Problem

A confused agent can keep working indefinitely, consuming API credits and blocking a workspace with no automatic intervention. This is a barrier to trusting the platform with a real API key. Additionally, when the iteration limit is hit, all interaction paths (chat UI, external API, agent-to-agent) currently discard whatever work the agent completed and return only an error — making the limit feel like a crash rather than a graceful stop.

## Goals

Give citizen developer a simple, per-workspace control over how much work an agent is allowed to do in a single run, make it obvious when that limit is reached, and ensure the agent always produces a final response when capped — regardless of how it is being called.

## Non-goals

- Detecting *why* an agent got stuck (stall detection, loop detection)
- Cost or time-based budgets
- Pause-and-confirm checkpoint instead of a hard stop
- Automatically retrying a callee that hit its limit (the calling agent decides)

## User stories

- As a user, I want to cap how many steps an agent can take so a confused agent cannot burn unbounded credits.
- As a user, I want each workspace to have its own cap so I can give more room to complex workspaces and keep simple ones tight.
- As a user interacting via chat, I want to see what the agent accomplished when it hits the limit, not just a bare error message.
- As an API caller, I want to receive a populated response even when the agent hits the limit, so I can use whatever work was done.
- As an agent calling another agent, I want to receive a partial result when the target hits its iteration limit so I can decide whether to retry or proceed with incomplete data.

## Requirements

### Must have

- Each workspace has a configurable maximum number of steps per run, defaulting to 30.
- The cap is set from the workspace settings panel on the home page — no config files or environment variables needed.
- When the iteration limit is reached, the agent produces a final text response before stopping, summarizing what it accomplished. This response is delivered through all interaction paths: chat UI, external API, and agent-to-agent calls.
- The final response is accompanied by a clear note that the iteration limit was reached, so the caller knows the response may be incomplete.
- The cap is enforced by the server regardless of what the agent decides to do — it cannot be bypassed by instructions in the workspace.

## Open questions

| Question | Owner | Status |
|----------|-------|--------|
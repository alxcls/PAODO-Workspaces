# PRD — Agent Loop Control

**Status:** Shipped  
**Author:** alxcls  
**Related:** [VISION.md](../VISION.md), [agent-loop.md](../agent-loop.md)

---

## Problem

A confused agent can keep working indefinitely, consuming API credits and blocking a workspace with no automatic intervention. This is a barrier to trusting the platform with a real API key. Additionally, when the iteration limit is hit, all interaction paths (chat UI, external API, agent-to-agent) currently discard whatever work the agent completed and return only an error — making the limit feel like a crash rather than a graceful stop.

The automatic cap is not enough on its own: a user watching the agent go the wrong way needs to stop it *now*, and a naive stop that only drops the client connection leaves the in-flight shell command running inside the container, still burning resources.

## Goals

Give citizen developer a simple, per-workspace control over how much work an agent is allowed to do in a single run, make it obvious when that limit is reached, and ensure the agent always produces a final response when capped — regardless of how it is being called. Also let the user stop a run in progress at any moment and have any in-flight command actually killed, not orphaned.

## Non-goals

- Detecting *why* an agent got stuck (stall detection, loop detection)
- Cost or time-based budgets
- Pause-and-confirm checkpoint instead of a hard stop
- Automatically retrying a callee that hit its limit (the calling agent decides)

## User stories

- As a citizen developer, I want to cap how many steps an agent can take so a confused agent cannot burn unbounded credits.
- As a citizen developer, I want each workspace to have its own cap so I can give more room to complex workspaces and keep simple ones tight.
- As a citizen developer interacting via chat, I want to see what the agent accomplished when it hits the limit, not just a bare error message.
- As an citizen developer, when I call the external API I want to receive a populated response even when the agent hits the limit, so I can use whatever work was done.
- As an citizen developer calling another agent, I want to receive a partial result when the target hits its iteration limit so I can decide whether to retry or proceed with incomplete data.
- As a citizen developer, I want to stop an agent mid-run the moment I see it going the wrong way, and trust that any command it was running is actually killed — not left running inside the container.

## Requirements

### Must have

- Each workspace has a configurable maximum number of steps per run, defaulting to 30.
- The cap is set from the workspace settings panel on the home page — no config files or environment variables needed.
- When the iteration limit is reached, the agent produces a final text response before stopping, summarizing what it accomplished. This response is delivered through all interaction paths: chat UI, external API, and agent-to-agent calls.
- The final response is accompanied by a clear note that the iteration limit was reached, so the caller knows the response may be incomplete.
- The cap is enforced by the server regardless of what the agent decides to do — it cannot be bypassed by instructions in the workspace.
- The user can interrupt a run already in progress (escape in the chat UI, or aborting the request).
- Interrupting kills the in-flight shell command for real — an in-container process-group kill, not merely dropping the host-side `docker exec` client — so no orphaned process keeps running after the stop.
- On interrupt the loop stops at the next safe point with conversation history left consistent: the in-flight turn's results are committed (not orphaned), so the session remains resumable.
- The UI reflects the stop immediately — no tool spinner is left running after an abort.

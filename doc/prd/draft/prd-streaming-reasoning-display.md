# PRD — Streaming Reasoning Display in Chat

**Status:** Draft  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md)

---

## Problem

When a reasoning-capable model (e.g. Claude Sonnet 4.6, OpenAI o4-mini) is configured for a workspace, its internal chain of thought is silently discarded. Users see only the final answer and have no visibility into *why* the agent made a decision or took a particular sequence of steps. This makes it harder to trust, debug, or guide the agent.

When a non-reasoning model is in use (e.g. Claude Haiku 4.5, GPT-4o mini), there is nothing to show — the UI should remain unchanged.

---

## Goals

- Surface model reasoning/thinking to the user in real time as it streams, for models that expose it.
- Degrade gracefully: when the active model does not support reasoning, the UI is identical to today.
- Work across both supported providers: Anthropic (thinking blocks) and OpenAI (o-series Responses API).
- Keep reasoning visually secondary to the final answer — it is a diagnostic aid, not the primary content.

---

## Non-goals

- Storing or persisting reasoning content beyond the current session.
- Surfacing reasoning for models that do not expose it at the API level (no simulation or prompt-engineering workarounds).
- A settings toggle to enable/disable reasoning per workspace (can be added later).

---

## User stories

**Story 1 — User watches the agent think in real time**  
As a user running a reasoning-capable model, I see a "Thinking…" section appear above the assistant's response as the model streams its chain of thought. I can read it live and understand the reasoning before the final answer arrives.

**Story 2 — User reviews reasoning after the answer**  
As a user who wants to audit why the agent chose a particular tool call, I can expand the collapsed reasoning block on any past message to read the full chain of thought.

**Story 3 — User runs a non-reasoning model**  
As a user with Claude Haiku 4.5 or GPT-4o mini configured, the chat UI looks and behaves exactly as it does today — no empty sections or placeholder text.

**Story 4 — User switches between models**  
As a user who changes the workspace model from Haiku to Sonnet, the next agent run shows reasoning; previous messages are unaffected.

---

## Requirements

### Must have

- A new `thinking` event type is added to the `AgentEvent` SSE stream, emitted only when the model produces reasoning content.
- The runner detects reasoning blocks from Anthropic (`thinking` content blocks) and OpenAI o-series (`reasoning` content items via Responses API) and maps them to the unified `thinking` event.
- Model support is detected at init time by model name — no runtime probing.
- The chat UI renders a collapsible "Reasoning" block above the assistant message bubble when `thinking` events arrive.
- The collapsible block is **expanded by default while streaming**, and **collapsed by default once the final answer arrives**.
- When no `thinking` events arrive for a turn, no reasoning block is rendered.

### Nice to have

- A small "Thinking" indicator icon or badge on the workspace header when reasoning is active for the configured model.
- Syntax highlighting or monospace rendering inside the reasoning block for code-heavy thinking.
- Smooth streaming animation inside the reasoning block (similar to the current token streaming in the answer).

---

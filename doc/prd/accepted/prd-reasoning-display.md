# PRD — Reasoning Display

**Status:** Accepted (shipped)
**Author:** alxcls
**Related:** [VISION.md](../VISION.md)

---

## Problem

The agent loop gave no visibility into model reasoning. Users saw tool indicators and a final response, but nothing about why the model made the decisions it did. Pre-tool narration text was incorrectly shown as the agent's response rather than internal thinking.

Both providers (OpenAI and Anthropic) expose native reasoning APIs but through different mechanisms, making it easy to support one at the expense of the other.

## Goals

- Surface real model reasoning in the UI, not inferred narration
- Unified visual treatment across providers
- Single operator-facing knob to control reasoning depth and cost

## Non-goals

- Showing raw unfiltered chain-of-thought (summaries are sufficient)
- Provider-specific UI differences
- Making reasoning configurable per workspace (global setting is enough)

## User stories

- As a citizen developer, I want to see what the agent was thinking before each tool call so I can understand and trust its decisions.
- As an citizen developer, I want to control reasoning cost without changing application logic.

## Requirements

### Must have

- **OpenAI:** use the Responses API (`useResponsesApi: true`) with `reasoning: { effort, summary: "auto" }`. Reasoning summary chunks arrive as `type: "reasoning"` content blocks and are streamed in real time.
- **Anthropic:** enable extended thinking (`thinking: { type: "enabled", budget_tokens: N }`). Thinking chunks arrive as `type: "thinking"` content blocks and are streamed in real time.
- **Unified `REASONING_EFFORT` env var:** `low | medium | high` (default `low`). Maps directly to OpenAI effort levels; translates to Anthropic budget_tokens (4k / 10k / 20k).
- **New `reasoning` AgentEvent:** runner emits `{ type: "reasoning", content }` for both block types, keeping provider differences out of the UI layer.
- **Thinking blocks in history:** for tool-call turns, push the full accumulated `AIMessageChunk` content (not just text) to conversation history so Anthropic receives thinking blocks verbatim as required by their API.
- **UI rendering:** `role: "reasoning"` messages render in small grey italic with ReactMarkdown, identical to the existing pre-tool text demotion style.

### Nice to have

- `xhigh` effort tier for OpenAI power users
- Per-workspace reasoning effort override

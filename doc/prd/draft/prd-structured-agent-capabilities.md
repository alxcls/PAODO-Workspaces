# PRD — Structured Agent Capabilities

**Status:** Draft  
**Author:** @alxcls  
**Related:** [prd-agent-network.md](../accepted/prd-agent-network.md)

---

## Problem

The current agent-to-agent (A2A) implementation passes free-form natural language between agents. The calling agent guesses what to say; the receiving agent guesses how to respond. This produces two failure modes:

- **Hallucinated calls** — the caller omits required fields, sends ambiguous prose, or invents workspace names
- **Hallucinated responses** — the callee returns a friendly paragraph instead of usable data, mixes prose with structured output, or fabricates field values

The root cause is that there is no contract between caller and callee. Neither agent knows what the other expects. This makes multi-agent workflows unreliable in practice even when the graph topology is correct.

## Goals

- Each workspace can declare a set of **capabilities**: named actions with typed inputs and a described output
- A calling agent knows exactly what a connected workspace can do and what arguments to pass
- A callee agent is instructed to behave as a structured responder and return typed output only
- The graph UI lets users define and edit capabilities without touching any files manually

## Non-goals

- Full Google A2A protocol compliance (HTTP Agent Cards, external discoverability) — this is in-process only
- Enforcing output schemas at runtime (JSON Schema validation of callee responses) — the system prompt is the contract enforcer, not code
- Capabilities shared across workspaces — each workspace defines its own
- Versioning or deprecation of capabilities

## Inspiration

This aligns conceptually with two emerging standards:

- **Google A2A (2025)** — agents expose an Agent Card listing skills with typed I/O; callers discover and invoke them as structured tasks. Our capabilities metadata is the in-process equivalent of an Agent Card.
- **Anthropic MCP** — tools expose typed schemas that LLMs fill correctly. We apply the same discipline to agent-to-agent calls: the capability schema is to `call_agent` what a tool schema is to a tool call.

The difference from MCP: callees have their own reasoning loop and agency. The difference from full A2A: everything runs in-process, no HTTP between agents.

## User stories

> As a citizen developer, I want to define what my stock agent can do (e.g. `check_stock(sku)`) so that any agent calling it knows exactly what to send and what to expect back.

> As a citizen developer, I want the calling agent to see a structured capability list when it calls `list_agents`, so it fills in the right fields without guessing.

> As a citizen developer, I want the capability definition to automatically shape the receiving agent's system prompt, so I don't have to manually write AGENTS.md instructions for structured responses.

> As a citizen developer, I want to define capabilities through the graph UI by clicking on a workspace node, not by editing JSON files.

## Requirements

### Must have

- A workspace can have zero or more **capabilities**, each with:
  - `name` — snake_case identifier (e.g. `check_stock`)
  - `description` — one sentence, shown to the calling agent
  - `input` — a flat map of `field → { type, description }` (string, number, boolean)
  - `output` — a free-text description of what is returned (e.g. `{ in_stock: boolean, quantity: number }`)
- Capabilities are stored in workspace metadata (same JSON store as `name`, `dir`, etc.)
- `list_agents` output includes each reachable agent's capabilities in a readable format:
  ```
  - stock-agent
    → check_stock(sku: string) — Returns inventory level for a given SKU
      returns: { in_stock: boolean, quantity: number, warehouse: string }
  ```
- `call_agent` schema requires `action` (capability name) and `args` (key-value pairs) in addition to `workspace`, replacing the free-form `message` string
- When a workspace has capabilities, its system prompt is automatically extended with a structured-responder block instructing it to accept JSON task requests and return JSON only
- When a workspace has no capabilities, behaviour is unchanged from today (plain `message` string, no structured prompt injection) — backwards compatible

### Must have (UI)

- Clicking a workspace node in the graph editor opens a side panel
- The panel shows the workspace's capability list with add / edit / delete
- Each capability is edited inline: name, description, input fields (add/remove rows), output description
- Save persists via `PATCH /api/workspaces/[id]`

### Nice to have

- Validate that `action` in `call_agent` matches a declared capability name and warn (not block) if it doesn't
- Export a workspace's Agent Card as JSON (Google A2A-compatible format) for future external discoverability
- `call_agent` falls back to plain `message` mode if the target workspace has no capabilities declared

# PRD — Prompt Caching

**Status:** Shipped  
**Author:** alxcls
**Related:** [VISION.md](../VISION.md)

---

## Problem

Every time the agent takes a step, it resends its full set of instructions to the AI provider and pays to reprocess them — even though those instructions never change. On long tasks with many steps, this adds up in both cost and response time.

## Goals

- Make the agent faster on multi-step tasks by avoiding redundant work each iteration
- Reduce API costs on Anthropic without changing any agent behaviour
- Optionally extend the savings window for long-running sessions

## Non-goals

- Changing what the agent does or how it reasons
- Any impact on the OpenAI path (already handled automatically by OpenAI)

## User stories

- As a citizen developer, I want the agent to feel snappier on the second and subsequent steps of a task.
- As an citizen developer, I want to pay less per agent run without touching any business logic.

## Requirements

### Must have

- Instructions that never change (how to behave, what tools to use, formatting rules) are cached on Anthropic's side and reused across steps — only the parts that vary per workspace (current date, workspace path, custom instructions) are sent fresh each time.

### Nice to have

- Cache lifetime can be extended to 1 hour for long sessions via an environment flag, so the savings persist across a full working session rather than expiring after 5 minutes.

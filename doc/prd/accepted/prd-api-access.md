# PRD — External API Access

**Status:** Shipped  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md)

---

## Problem

A workspace agent is useful beyond the browser UI — it should be triggerable from external tools like chatbots, automation pipelines, or scripts. Without a programmatic entry point, the agent is locked inside the platform and cannot be composed with the rest of a user's stack.

## Goals

- Any external system can trigger a workspace agent via HTTP
- Access is controlled per workspace — the owner decides who can call in
- A compromised or shared key can be revoked instantly without affecting other workspaces

## Non-goals

- Shared or platform-wide API keys — each key is scoped to one workspace
- Fine-grained permissions (read-only, write-only) — a valid key allows to call the agent and the agent decides what is permitted or not inside it's workspace according to it's prompt
- Webhooks or callbacks — the caller drives the interaction, not the platform

## User stories

> As a citizen developer, I want to call my "invoice-parser" workspace from my chatbot so that users can trigger it with natural language without accessing the platform directly.

> As a citizen developer, I want to revoke a workspace's API key if it leaks, without disrupting my other workspaces.

> As a citizen developer, I want to temporarily disable a workspace's API access without losing the key, so I can pause external calls during maintenance.

## Requirements

### Must have

- Each workspace can generate an API key — shown once at generation, never retrievable again
- Key can be revoked at any time, immediately invalidating all calls using it
- Key can be enabled or disabled independently from revocation
- External caller sends a message to the workspace agent and receives the final response
- Unauthorized or disabled calls are rejected with a clear error
- Rate limiting per caller IP to prevent abuse

### Nice to have

- UI to manage the key state (generate, revoke, enable/disable) directly from the workspace settings

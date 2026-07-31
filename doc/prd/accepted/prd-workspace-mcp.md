# PRD — Workspace MCP

**Status:** Shipped
**Related:** [Structured A2A Capabilities](prd-structured-A2A-capabilities.md)

## Problem

A workspace can be a useful specialist application inside PAODO. External AI
clients need a simple way to discover and call that workspace's skills without
knowing PAODO's internal agent graph or files and folders.

## Goal

Let a workspace expose the A2A skills it declares as its own focused MCP.

## User stories

> As a workspace owner, I want to expose my SAP documentation workspace to an
> external AI client I trust with its secret, so it can use that workspace's
> specialist capabilities and nothing else.

> As an external user, I want to receive a structured test script from a
> workspace, so I can use it in another system.

## Requirements

- A workspace can enable or disable its Workspace MCP.
- A Workspace MCP exposes every skill that workspace declares in `.skills/`, and
  only that workspace's skills. There is no per-skill publication step: enabling
  the endpoint and holding its secret is the whole authorization decision.
- Each skill becomes an MCP tool with the same input and output contract as the
  A2A skill.
- A skill that returns structured data returns the same validated JSON through
  MCP.
- Each Workspace MCP has a separate revocable credential.
- Calls use the existing skill validation and execution path.
- The exposed set follows `.skills/` live: a skill the workspace agent adds is
  callable immediately, and one it deletes stops being listed and stops being
  callable. Disabling the MCP or revoking its secret closes the endpoint
  immediately.
- The owner can see the current exposed tool list, so an agent adding or
  removing a tool their client depends on is visible.

## Non-goals

- Combining skills from different workspaces.
- Replacing workspace chat or internal A2A calls.
- Exposing agent tools, files, or any workspace capability that is not a
  declared skill.
- Serving clients the workspace owner does not control. The secret is given
  deliberately; anyone holding it can reach every declared skill.

## Acceptance criteria

- An enabled workspace MCP lists exactly the skills that workspace declares, and
  no skill from any other workspace.
- A valid MCP tool call runs the matching workspace skill and returns its
  promised output.
- A tool name the workspace does not declare cannot be called, including one
  deleted after a client cached the tool list.
- A revoked credential, or a disabled MCP, cannot discover or call any skill.

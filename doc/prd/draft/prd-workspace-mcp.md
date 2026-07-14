# PRD — Workspace MCP

**Status:** Draft  
**Related:** [Structured A2A Capabilities](../accepted/prd-structured-A2A-capabilities.md)

## Problem

A workspace can be a useful specialist application inside PAODO. External AI
clients need a simple way to discover and call that workspace's published
skills without knowing PAODO's internal agent graph or files and folders.

## Goal

Let a workspace expose its published A2A skills as its own focused MCP.

## User stories

> As a workspace owner, I want to expose my SAP documentation workspace to an
> external AI client, so it can use only the specialist capabilities I publish.

> As an external user, I want to receive a structured test script from a
> workspace, so I can use it in another system.

## Requirements

- A workspace can enable or disable its Workspace MCP.
- A Workspace MCP exposes only that workspace's published skills.
- Each published skill becomes an MCP tool with the same input and output
  contract as the A2A skill.
- A skill that returns structured data returns the same validated JSON through
  MCP.
- Each Workspace MCP has a separate revocable credential.
- Calls use the existing skill validation and execution path.
- Disabling the Workspace MCP or removing a skill makes it unavailable
  immediately.
- A workspace MCP can be scoped from 1 to n A2A skills

## Non-goals

- Combining skills from different workspaces.
- Replacing workspace chat or internal A2A calls.
- Exposing unpublished workspace tools or files.

## Acceptance criteria

- An enabled workspace MCP lists only its own published skills.
- A valid MCP tool call runs the matching workspace skill and returns its
  promised output.
- An unknown, unpublished, or disabled skill cannot be called.
- A revoked credential cannot discover or call workspace skills.

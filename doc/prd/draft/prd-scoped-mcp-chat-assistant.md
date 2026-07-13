# PRD — Scoped MCP Chat Assistant

**Status:** Draft  
**Related:** [App-wide MCP Gateway](prd-app-wide-mcp-gateway.md)

## Problem

Employees need a PAODO chat assistant that can help across their work. Each
assistant needs access to several chosen MCPs, and no others.

## Goal

Provide each employee with a platform-level assistant, not tied to one
workspace, with a selected set of MCPs it can use.

## User stories

> As an employee, I want to ask my assistant for help without choosing a
> workspace or tool first, so it can use the right connected MCP for my task.

> As an administrator, I want to assign several MCPs to each employee's
> assistant, so every assistant has only the tools appropriate to that person.

## Requirements

- Each employee has an assigned assistant, available from a chat interface
  outside individual workspace pages.
- An assistant can have several attached MCPs.
- An assistant can discover and use only tools provided by its attached MCPs.
- An administrator can add, remove, or replace an assistant's MCPs.
- A removed MCP is unavailable immediately.
- The assistant identifies the MCP and, where relevant, the PAODO workspace it
  used when returning a result.
- Conversations and activity show the employee, MCP, tool, and result.
- Existing workspace chat and API access continue unchanged.

## Non-goals

- Giving every assistant access to every MCP.
- Replacing individual workspace chat.
- Letting an assistant use a tool from an MCP that is not attached to it.

## Acceptance criteria

- An employee's assistant sees and can use tools from its assigned MCPs only.
- The assistant successfully selects and calls an appropriate attached MCP.
- A tool from an unattached MCP is not shown or callable.
- Removing an MCP makes its tools unavailable to the assistant immediately.

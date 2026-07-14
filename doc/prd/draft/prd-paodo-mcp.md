# PRD — PAODO MCP

**Status:** Draft
**Related:** [Workspace MCP](prd-workspace-mcp.md)

## Problem

Some assistants need a small, purpose-built set of skills from several PAODO
workspaces. Connecting them to every Workspace MCP creates too many tools and
makes the assistant less reliable.

## Goal

Let PAODO create curated MCPs that expose selected published skills from
multiple workspaces.

## User stories

> As an administrator, I want to create an SAP Rollout MCP containing only the
> SAP documentation, test automation, and reporting skills needed by that work.

> As an assistant owner, I want to connect my assistant to a focused PAODO MCP,
> so it does not receive unrelated tools.

## Requirements

- An administrator can create, name, enable, disable, and delete a PAODO MCP.
- A PAODO MCP contains explicit references to published workspace skills.
- A PAODO MCP may combine skills from multiple workspaces.
- It reuses each referenced skill's existing input and output contract; skill
  definitions are never copied.
- The MCP lists and accepts calls only for its selected skills.
- Each PAODO MCP has separate revocable credentials.
- Removing a skill from the catalog, unpublishing it, disabling its Workspace
  MCP, or deleting its workspace removes it from the PAODO MCP immediately.
- Calls are validated, rate-limited, and audited with the PAODO MCP, source
  workspace, skill, caller, and result.

## Non-goals

- Automatically exposing all PAODO workspaces.
- Replacing Workspace MCPs.
- Letting a PAODO MCP call a skill that is not explicitly selected.

## Acceptance criteria

- A PAODO MCP lists only the workspace skills selected for it.
- A connected assistant can call a selected skill and receives its validated
  output.
- A non-selected skill cannot be discovered or called.
- Updating the PAODO MCP's selected skills takes effect immediately.

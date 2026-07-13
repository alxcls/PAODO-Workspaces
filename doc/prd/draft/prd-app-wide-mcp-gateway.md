# PRD — App-wide MCP Gateway

**Status:** Draft  
**Related:** [Structured A2A Capabilities](../accepted/prd-structured-A2A-capabilities.md), [API Access](../accepted/prd-api-access.md)

## Problem

External generalist agents need to use skills from selected PAODO workspaces.
Configuring one MCP connection per workspace is inconvenient, while exposing every
workspace through one MCP server would break workspace isolation.

## Goal

Expose one PAODO MCP endpoint that lets an authenticated external client discover
and call skills in only the workspaces it is explicitly allowed to reach.

## Non-goals

- Replacing the existing per-workspace HTTP agent API.
- Exposing free-form agent chat as an MCP skill.
- Giving an MCP client access to all workspaces by default.
- Changing internal A2A graph permissions.

## User stories

> As a user, I want to create an MCP client and choose the workspaces it may
> reach, so my generalist agent can coordinate only those workspaces.

> As a user, I want to revoke a client's access without changing workspace API
> keys or affecting other clients.

## Requirements

- PAODO provides one app-wide MCP endpoint.
- An MCP client has its own revocable credential; it is separate from a
  workspace API key.
- Each client has an explicit allowlist of reachable workspaces. Per-skill
  restrictions may be added later.
- Discovery returns only allowed workspaces and their published skills. It must
  not reveal names, descriptions, or skills of unapproved workspaces.
- Calls use the existing structured-skill schemas and validation/correction
  pipeline. MCP is an adapter, not a second contract system.
- The initial MCP tool set is small and stable:
  - `list_workspaces`
  - `list_skills(workspace)`
  - `call_skill(workspace, skill, input)`
- Every call is authorized against the client allowlist, rate-limited, and
  logged with client, workspace, skill, outcome, and duration.
- Revoking a client or removing a workspace grant takes effect immediately.
- A workspace's secrets remain scoped to that workspace and continue to use the
  credential proxy; the MCP client never receives them.

## Acceptance criteria

- A client granted access to workspace A can discover and call A's skills.
- The same client cannot discover or call workspace B without a grant.
- Invalid skill input receives the existing precise validation error.
- Removing access to A causes subsequent discovery and calls for A to fail.
- Existing workspace API keys and HTTP agent calls continue unchanged.

## Future considerations

- Per-skill grants.
- Namespaced direct tools for small, curated skill sets.
- Async run status for long-running skills.

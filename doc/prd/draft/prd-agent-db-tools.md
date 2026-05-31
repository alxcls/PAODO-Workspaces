# PRD — Agent Database Tools

**Status:** Draft
**Author:** @alxcls
**Related:** [VISION.md](../VISION.md), [prd-agent-network.md](../accepted/prd-agent-network.md), [prd-agent-toolset.md](../accepted/prd-agent-toolset.md)

---

## Problem

Agents have no way to inspect or query external databases. Users who want the agent to reason over structured data must export it to files first, which is tedious and breaks the real-time feedback loop.

## Goals

- An agent can list the database connections available to its workspace and run SQL against them
- Platform admins can attach a database to a workspace from the network view without touching config files

## Non-goals

- Managing database schema migrations
- Deciding which database engines are supported (driver support is an implementation decision)
- Row-level access control beyond what the DB user's permissions already enforce

## User stories

> As a developer, I want the agent to query my project's database directly so it can answer questions about live data without me exporting CSV files.

> As a platform admin, I want to wire a database connection to a workspace from the network view the same way I connect two workspaces.

## Requirements

### Must have

- `list_db` tool: returns the list of database connections attached to the current workspace (name, type, host)
- `query_db` tool: accepts a connection name and a SQL string, executes it, and returns the result set; supports both reads and writes
- DB connections are workspace-scoped: a workspace only sees connections explicitly attached to it
- In the network view, a DB appears as a first-class node; dragging an edge from a DB node to a workspace node attaches that connection to the workspace
- Connection credentials (host, port, user, password, database name) are entered when the DB node is created and stored securely server-side; the agent receives only the connection name, not raw credentials

### Nice to have

- Query results truncated with a summary when the row count exceeds a configurable limit
- Read-only mode toggle per connection (admin can restrict a connection to SELECT only regardless of DB user permissions)

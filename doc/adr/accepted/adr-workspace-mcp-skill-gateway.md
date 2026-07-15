# ADR — Workspace MCP gateway over published skills

Status: Accepted

Context
External AI clients need a standard way to discover and call workspace capabilities without gaining access to the PAODO UI, filesystem, or agent network.

Decision
Expose each workspace through the stateless Streamable HTTP endpoint `POST /api/workspaces/<id>/mcp`.

- Authenticate with a dedicated per-workspace Bearer secret. Store only its SHA-256 hash; allow minting, rotation, revocation, and enable/disable through the authenticated `mcp-config` API.
- Expose only skill IDs explicitly selected for MCP publication. Read their input and output contracts from `.skills/*.json`; both schemas must declare `type: "object"`.
- Create a fresh MCP server and buffered transport for every request. `GET` and `DELETE` return `405` because no MCP session or server-to-client stream is retained.
- Execute tool calls through `executeSkill`, reusing the selected skill definition and the normal input/output validation. The MCP credential replaces the agent-network edge check; all other execution behavior remains shared.
- Rate-limit requests by client IP. The public reverse proxy permits only the workspace agent and MCP POST routes.

Consequences
- MCP clients see a small, explicitly published and revocable tool surface per workspace.
- MCP and agent-to-agent calls share one skill contract and execution path.
- Calls have no MCP session state; each tool execution still creates an auditable workspace conversation.
- Skill authors must provide object-shaped JSON Schema contracts.

Alternatives considered
- Expose every workspace skill automatically: rejected because publication must be explicit.
- Reuse the workspace HTTP API key: rejected to keep MCP access independently revocable.
- Maintain stateful MCP sessions and SSE: rejected because current tools need only request/response exchanges.
- Implement a separate MCP execution engine: rejected to avoid diverging validation and runtime behavior.

Notes
- Related ADRs: [Agent-to-agent server-mediated calls](adr-agent-to-agent-server-mediated-calls.md) — defines the agent-network edge check and shared `executeSkill` path this endpoint reuses.
- Related PRDs: [Workspace MCP](../../prd/draft/prd-workspace-mcp.md)

# ADR — Workspace MCP gateway over declared skills

Status: Accepted

Context
External AI clients need a standard way to discover and call workspace capabilities without gaining access to the PAODO UI, filesystem, or agent network.

The audience is a client the workspace owner has deliberately handed a secret to — typically another of their own agents — not an anonymous caller.

Decision
Expose each workspace through the stateless Streamable HTTP endpoint `POST /api/workspaces/<id>/mcp`.

- Authenticate with a dedicated per-workspace Bearer secret. Store only its SHA-256 hash; allow minting, rotation, revocation, and enable/disable through the authenticated `mcp-config` API.
- Expose every skill the workspace declares in `.skills/*.json`, read live on each request. Both schemas must declare `type: "object"`. There is no per-skill publication step: the endpoint being enabled plus a valid secret is the whole authorization decision, mirroring how an Agent-Network edge authorizes a whole workspace for A2A rather than individual skills.
- Create a fresh MCP server and buffered transport for every request. `GET` and `DELETE` return `405` because no MCP session or server-to-client stream is retained.
- Execute tool calls through `executeSkill`, resolving the skill from the same live read `tools/list` uses and reusing the normal input/output validation. The MCP credential replaces the agent-network edge check; all other execution behavior remains shared.
- Rate-limit requests by client IP. The public reverse proxy permits only the workspace agent and MCP POST routes.

Consequences

- The tool surface is whatever the workspace agent has written to `.skills/`. Creating a skill makes it callable immediately; deleting one makes it both unlisted and uncallable.
- Publication is therefore agent-controlled. A prompt injection reaching the workspace agent can add a durable public entry point, bounded by the fact that a caller must already hold the secret and that skill execution grants no capability the agent does not already have. The secret and the enable toggle are the control points; they are stored outside the workspace directory, so the agent cannot alter them.
- Because the endpoint is stateless it cannot send `tools/list_changed`. A client working from a cached list may call a deleted skill and receives an "Unknown tool" error naming the available ones. Contract changes to a still-existing skill surface as `INPUT_VALIDATION_ERROR`, so integrations should treat a workspace's tool list as re-readable rather than fixed.
- MCP and agent-to-agent calls share one skill contract and execution path, with no notion of a skill exposed to one and not the other.
- Calls have no MCP session state; each tool execution still creates an auditable workspace conversation.
- Skill authors must provide object-shaped JSON Schema contracts.

Alternatives considered

- Per-skill publication, selected by the user and stored outside the workspace (the original decision, since reverted): rejected because the gate authorized a skill _id_ while the agent remained free to change what that id does, and because the id-keyed selection went stale — a skill deleted and recreated under the same name silently regained exposure. It cost a second store, a write API, and a UI without bounding what a caller could reach.
- A user-acknowledged pin over the exposed set (hash of ids plus schemas, re-approved on drift): rejected as unnecessary for a trusted-client audience, since the endpoint's own toggle and secret already gate access. Worth revisiting if a workspace's MCP is ever handed to a party the owner does not control.
- A `visibility` field inside each skill file: rejected because `.skills/` is agent-writable, so an in-workspace marker cannot express a decision the agent is not allowed to make.
- Reuse the workspace HTTP API key: rejected to keep MCP access independently revocable.
- Maintain stateful MCP sessions and SSE: rejected because current tools need only request/response exchanges.
- Implement a separate MCP execution engine: rejected to avoid diverging validation and runtime behavior.

Notes

- Related ADRs: [Agent-to-agent server-mediated calls](adr-agent-to-agent-server-mediated-calls.md) — defines the agent-network edge check and shared `executeSkill` path this endpoint reuses.
- Related PRDs: [Workspace MCP](../../prd/draft/prd-workspace-mcp.md)

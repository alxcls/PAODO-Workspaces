# ADR — Per-workspace API key & HTTP agent endpoint

Status: Accepted

Context
Workspaces should be callable from external tools (scripts, bots). API key compromises must be limited in scope and easily revocable.

Decision
Expose an HTTP endpoint `POST /api/workspaces/<id>/agent` authenticated with a per-workspace API key (Bearer token). Keys are shown once at generation, revocable, and can be enabled/disabled. Rate-limit calls by client IP.

Consequences
- Fine-grained revocation and limited blast radius for leaked keys.
- External callers must handle stateless requests (server treats external API calls as fresh context unless the caller passes history).
- Requires secure key management and UI for generation/revocation.

Alternatives considered
- Platform-wide API key (too coarse).  
- OAuth/JWT-based integration (more complexity than needed for initial self-hosted use).

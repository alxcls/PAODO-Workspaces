# ADR — Agent-to-agent communication via server-mediated calls (acyclic graph)

Status: Accepted

Context
Complex services benefit from specialized agents that delegate work to other workspace agents. Direct container-to-container networking is undesired for security and isolation reasons.

Decision
Implement a directed, acyclic agent network where calls are routed through the platform server (`call_agent` tool). Each call invokes the callee with a fresh conversation context. The UI enforces acyclicity and a graph editor lets users define allowed connections.

Consequences
- Controlled and auditable cross-workspace interactions; easy to rate-limit and monitor.
- Callee runs are stateless by design; callers must manage state if they need it.
- Requires server routing logic and UI for graph management.

Alternatives considered
- Direct container networking (risk of lateral movement and weaker access control).
- Shared persistent state for hand-offs (breaks isolation guarantees).

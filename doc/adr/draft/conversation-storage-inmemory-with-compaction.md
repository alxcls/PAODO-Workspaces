# ADR — Conversation storage: in-memory with lightweight disk compactions

Status: Draft

Context
Long-running sessions may grow until the model's context limit is reached. Persisting full conversation history to disk increases storage, privacy surface, and complexity.

Decision
Keep conversation history in-memory per browser session. Persist only workspace metadata and compacted summaries to disk (append-only `data/<workspace>/compactions.json`). Provide short-TTL encrypted snapshots of original turns to enable a best-effort undo.

Consequences
- Low persistent storage footprint and simpler operations.
- Long sessions require compaction to avoid context exhaustion (see ADR for compaction).
- Server restarts lose full fine-grained history; distilled summaries remain.

Alternatives considered
- Full persistent conversation DB: durable but higher complexity and storage growth.
- Immediate indexing into a vector DB for long-term memory: out of scope and adds infra.

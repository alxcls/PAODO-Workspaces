# ADR — Conversation storage: in-memory with in-memory compaction

Status: Accepted

Context
Long-running sessions may grow until the model's context limit is reached. Persisting full conversation history to disk increases storage, privacy surface, and complexity.

Decision
Keep conversation history **in-memory per session** (browser chat for the tab session; external API and agent-to-agent calls are stateless and start fresh). Only workspace metadata and the agent graph are persisted to disk under `data/`. Conversation history is never written to disk.

Context exhaustion is handled in memory by agent-driven compaction (see [adr-context-compaction-via-llm-summarization.md](adr-context-compaction-via-llm-summarization.md)), which rewrites the live `messages` array in place. There is no on-disk record of compactions and no undo — there is nothing durable to roll back to, by design.

Consequences
- Minimal persistent storage footprint and simpler operations; small privacy surface (no chat logs on disk).
- Long sessions rely on compaction to avoid context exhaustion.
- Server restart or tab close loses conversation history entirely. Workspace files (scripts, data, `AGENTS.md`) are the intended long-term memory.

Alternatives considered
- **Persisted compactions + encrypted short-TTL undo snapshots** (`compactions.json`): auditable and reversible, but adds storage, a privacy surface, and operational complexity. Dropped in favor of pure in-memory compaction.
- **Full persistent conversation DB**: durable but higher complexity and storage growth.
- **Immediate indexing into a vector DB for long-term memory**: out of scope and adds infra.

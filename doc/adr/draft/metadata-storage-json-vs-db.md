# ADR — Metadata storage: JSON files vs relational DB

Status: draft (JSON now; DB optional later)

Context
Platform metadata (workspace registry, API keys, agent graph) must be durable and safe for simple self-hosted deployments. Multi-instance operation and concurrent admins introduce consistency challenges.

Decision
Keep a JSON file-backed store under `data/` with an in-memory cache for performance. Design the storage layer with an abstraction so a migration to SQLite/Postgres is possible when multi-instance or concurrency requirements arise.

Consequences
- Simple to inspect and back up for single-instance deployments.
- Not safe for concurrent multi-instance setups without coordination; plan for migration when needed.
- Lower operational burden for initial self-hosted adopters.

Alternatives considered
- Ship with SQLite or Postgres immediately (more operational complexity).
- Use a distributed KV store (overkill for initial deployments).

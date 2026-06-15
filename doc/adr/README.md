ADR index — design decisions for PAODO_WS

This directory contains Architecture Decision Records (ADRs) for the project. Files are numbered for chronological ordering.

Current ADRs:

- container-per-workspace-sandbox.md — Container-per-workspace sandbox (Accepted)
- conversation-storage-inmemory-with-compaction.md — Conversation storage (Draft)
- context-compaction-via-llm-summarization.md — Context compaction (Draft)
- per-workspace-api-key-http-endpoint.md — Per-workspace API key & HTTP endpoint (Accepted)
- agent-to-agent-server-mediated-calls.md — Agent-to-agent via server (Accepted)
- metadata-storage-json-vs-db.md — Metadata storage: JSON vs DB (Accepted)
- single-llm-provider-global-model.md — Single LLM provider & global model (Accepted)
- single-instance-in-process-state.md — Single-instance, in-process coordination state (Accepted)

To add a new ADR: create `doc/adr/000X-descriptive-title.md` and follow the format: Status / Context / Decision / Consequences / Alternatives.

# ADR — Context compaction via deterministic LLM summarization

Status: Draft

Context
Session histories can grow unbounded and hit the model's context window. We need a way to reduce token usage while preserving key facts and tool outputs.

Decision
When a per-session token threshold is exceeded, replace the oldest contiguous subset of turns (protecting N most recent turns) with a single structured summary produced by a deterministic summarization prompt to the configured OpenAI model. Persist compaction entries to `data/<workspace>/compactions.json`. Store encrypted short‑TTL snapshots to allow undo of the most recent compaction.

Consequences
- Extends usable session length and preserves salient facts.
- Requires prompt engineering and evaluation to avoid information loss.
- Adds API cost for summarization operations and operational monitoring requirements.

Alternatives considered
- Heuristic truncation: simple but loses important information.
- External vector DB + retrieval: powerful but increases infra complexity and is out of scope for now.

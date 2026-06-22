# ADR — Agent-driven context compaction via LLM summarization

Status: Accepted

Context
Session histories grow turn over turn and eventually hit the model's context window — especially on long, multi-unit jobs where re-derivable tool output (file reads, search results, command logs) dominates the token count. We need a way to reclaim context without breaking the conversation.

A key hard constraint: the message history must always stay valid for the active provider. In particular, every `tool_call` must keep its matching `tool_result` in the same window (Anthropic's invariant), so any compaction that deletes messages can only ever keep or wipe *complete* turns — never half of one.

Decision
Compaction is **agent-driven**, not automatic. A tool-less `compact_context` tool lets the agent signal that it wants to compact, choosing a level and passing a `next_step` note so it doesn't lose the thread after trimming. The tool is a **signal only** — it cannot reach the live `messages` array. The runner, which is the sole owner of that array, performs the actual surgery in [`applyCompaction`](../../lib/agent/compact.ts) *after* the requesting turn's assistant+tool_result pair is fully committed, so history is never left orphaned.

Two primitives compose three levels:
- **light** — strip re-derivable tool output (file_read, glob, list_directory, http_get, execute_command) in place, replacing it with a placeholder. No LLM call, no deletion, so no pair can be orphaned. The cheap win against O(n²) token compounding.
- **medium** — strip, then summarize the old head into a single brief while keeping a recent verbatim tail. The tail boundary snaps forward to the next assistant message so kept tool_calls retain their tool_results.
- **hard** — summarize everything into one brief: a clean slate (system message + summary + next step).

Summarization is a single tool-less call to **the workspace's configured chat model** — whichever provider is active (OpenAI, Anthropic, or DeepSeek via `LLM_PROVIDER`). It is deliberately provider-agnostic: the runner passes the same `model` it already uses for the loop. todo_write, compact_context, and call_agent/list_agents output is never stripped (it's the live checklist / carries next_step / is not re-derivable).

Consequences
- Extends usable session length while keeping every kept turn provider-valid.
- The agent decides when to compact (prompted to do so between independent units of long jobs); there is no size-triggered automatic compaction yet — that remains future work.
- Adds API cost for the summarize call on medium/hard (light is free).
- No persistence and no undo: compaction mutates in-memory history in place. History is already in-memory only (see [adr-conversation-storage-inmemory-with-compaction.md](adr-conversation-storage-inmemory-with-compaction.md)), so there is nothing durable to roll back to.

Alternatives considered
- **Automatic token-threshold trigger** (compact when history exceeds N% of context): removes the need for the agent to remember, but couples compaction to token accounting and can fire mid-task at a bad boundary. Kept as future work rather than the first cut.
- **Persisted compactions + encrypted short-TTL undo snapshots** (`compactions.json`): auditable and reversible, but adds storage, a privacy surface, and operational complexity that the in-memory model deliberately avoids. Dropped.
- **Heuristic truncation**: simple but loses important information with no summary to stand in.
- **External vector DB + retrieval**: powerful but increases infra complexity and is out of scope.

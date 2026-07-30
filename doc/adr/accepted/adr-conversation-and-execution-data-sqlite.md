Title: Conversation replay and execution history share one versioned SQLite database

Status: Accepted

Context
The application has two durable but distinct data models:

- Conversation replay state: conversation metadata plus the serialized messages required to resume
  an agent chat.
- Execution history: immutable per-LLM-turn usage, cost, reasoning, output, errors, and ordered tool
  calls used by the monitoring dashboard and chat token display.

These models share an operational boundary: both must survive restarts, be ready before their
feature stores query them, and be backed up consistently. They do not share authority. Conversation
messages answer “what must the model replay?”, while execution records answer “what ran and what did
it consume?”. Treating either representation as the other would couple chat replay to monitoring
retention and create duplicate token authorities.

Both models contain sensitive plaintext. Conversation messages, prompts, reasoning, tool arguments,
and tool output may include private instructions, file contents, command output, or secrets the
agent encountered.

Decision
Store conversation replay and execution history in separate tables inside one application-level
SQLite database at `data/.paodo.db`.

`lib/data/database.ts` owns the connection, SQLite pragmas, migrations, and backup operation.
`lib/data/migrations/` is the sole schema authority. Migrations are forward-only, sequential, and
tracked with SQLite `PRAGMA user_version`; all pending migrations run atomically before the
connection is exposed. Startup fails if a migration fails or if the database was created by a newer
application version.

Feature stores own only their domain queries:

- `conversations` is authoritative for replayable conversation metadata and messages.
- `usage_turns` is authoritative for per-LLM-turn token facts, frozen cost, text, and errors.
- `usage_tool_calls` stores the ordered tools associated with an execution turn.

`usage_turns.conversation_id` is a logical association, not a foreign key to `conversations`.
Execution history therefore survives conversation deletion. Replay messages keep only the stable
execution-turn identifier needed to attach the execution ledger’s aggregate token total when a
conversation is reopened; they do not store a second token snapshot.

A usage turn and its tool calls are committed in one transaction. The database uses WAL mode,
`synchronous=FULL`, foreign-key enforcement, and a busy timeout. Large execution text remains in
SQLite but is omitted from the dashboard’s lightweight list query and loaded only for a selected
session. The dashboard’s 5000-turn list limit bounds one response and is not a retention policy.

The stored content remains unredacted. Confidentiality relies on the single-user deployment’s
network and authentication boundaries. The UI and usage routes stay behind the selected
authenticated HTTPS ingress and PAODO Basic Auth; the public Caddy gateway exposes only separately
authenticated programmatic API and MCP routes.

Create backups through
`npm run backup:database -- /path/on/separate-storage/paodo.db`, then copy the snapshot to separately
backed-up or remote storage. A second file on the same Docker volume is not disaster recovery.

Consequences

- Opening the database always means both conversation and execution schemas are ready.
- One consistent snapshot backs up both data models, while their table boundaries preserve their
  different meanings and lifecycles.
- Chat replay cannot silently become the token authority, and dashboard retention cannot break
  conversation replay.
- Deleting a conversation removes replay state without erasing the historical execution ledger.
- Schema changes require a new migration and a pre-deployment backup; shipped migrations must never
  be edited.
- The database grows with conversation and execution history. Retention remains an explicit
  operator policy.
- Anyone with host access can read sensitive plaintext. This is acceptable only under the current
  single-user threat model. A multi-tenant UI would require
  authentication, per-workspace authorization, and reconsideration of redaction or encryption at
  rest.
- The database does not replace workspace files or every existing runtime store; it is the shared
  durability boundary specifically for conversation replay and execution history.

Alternatives considered

- Use separate SQLite files for conversations and usage — rejected because readiness, migrations,
  backup, and recovery would have multiple owners without providing independent durability.
- Store execution measurements inside conversation messages — rejected because token data would
  have two authorities, monitoring history would depend on replay retention, and non-chat runs would
  not fit.
- Store conversations and executions in the same table — rejected because they have different
  identities, lifecycles, and query patterns.
- Keep conversations in per-workspace JSON and usage in JSONL — rejected because it duplicates
  write and recovery logic, weakens transactional guarantees, and makes indexed dashboard queries
  harder.
- Redact persisted tool and message content — rejected for the current single-user deployment
  because reliable secret detection is unavailable and lossy redaction removes debugging value.
  Revisit if the threat model changes.

Notes
Related requirements:
`doc/prd/accepted/prd-persistent-conversations.md` and
`doc/prd/accepted/prd-monitoring-dashboard.md`.

Implementation:
`lib/data/database.ts`, `lib/data/migrations/`, `lib/workspace/conversationStore.ts`,
`lib/workspace/usageStore.ts`, `app/api/usage/`, and `app/dashboard/page.tsx`.

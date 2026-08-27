import type { Migration } from "./index";

/**
 * The starting schema. The opening sweep drops by name from sqlite_master rather than a fixed list,
 * so pointing this at a database left behind by an older shape rebuilds it; on the fresh database it
 * normally runs against, it finds nothing.
 *
 * From here on, schema changes are ordinary migrations: add a file, do not edit this one.
 */
export const baselineSchema: Migration = {
  version: 1,
  name: "baseline",
  up(db) {
    const stale = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const { name } of stale) db.exec(`DROP TABLE IF EXISTS "${name}"`);

    db.exec(`
      CREATE TABLE conversations (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        conversation_id TEXT,
        origin TEXT NOT NULL CHECK (
          origin IN ('chat', 'api', 'mcp', 'scheduled', 'agent', 'manual')
        ),
        user_input TEXT,
        system_prompt TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('running', 'success', 'failed', 'cancelled', 'timeout', 'limit_reached', 'incomplete')
        ),
        error_code TEXT,
        error_message TEXT
      );

      CREATE TABLE turns (
        -- seq preserves recording order when timestamps are equal, within a session and across all
        -- of them. AUTOINCREMENT prevents reuse if a retention policy removes the newest rows.
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        model TEXT,
        input_tokens_total INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens_total >= 0),
        input_tokens_cache_read INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens_cache_read >= 0),
        input_tokens_cache_write INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens_cache_write >= 0),
        output_tokens_total INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens_total >= 0),
        output_tokens_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens_reasoning >= 0),
        cost_amount REAL CHECK (cost_amount IS NULL OR cost_amount >= 0),
        cost_currency TEXT CHECK (cost_currency IS NULL OR cost_currency IN ('USD', 'EUR')),
        reasoning_text TEXT,
        output_text TEXT,
        tool_calls_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_calls_json)),
        CHECK (
          (cost_amount IS NULL AND cost_currency IS NULL) OR
          (cost_amount IS NOT NULL AND cost_currency IS NOT NULL)
        )
      );

      CREATE INDEX conversations_workspace_recent_idx
        ON conversations(workspace_id, last_message_at DESC, updated_at DESC);
      CREATE INDEX sessions_workspace_started_idx
        ON sessions(workspace_id, started_at DESC);
      CREATE INDEX sessions_conversation_idx
        ON sessions(conversation_id);
      CREATE INDEX turns_session_seq_idx
        ON turns(session_id, seq);
    `);
  },
};

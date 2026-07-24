import type { Migration } from "./index";

export const initialSchema: Migration = {
  version: 1,
  name: "initial-schema",
  up(db) {
    db.exec(`
      CREATE TABLE conversations (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT CHECK (kind IS NULL OR kind IN ('user', 'skill-call', 'scheduled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );

      CREATE INDEX conversations_workspace_recent_idx
        ON conversations(workspace_id, last_message_at DESC, updated_at DESC);

      CREATE TABLE usage_turns (
        -- seq preserves recording order when timestamps are equal. AUTOINCREMENT prevents reuse if
        -- a future retention policy removes the newest rows.
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        origin TEXT CHECK (
          origin IS NULL OR origin IN ('chat', 'api', 'mcp', 'scheduled', 'agent', 'manual')
        ),
        timestamp TEXT NOT NULL,
        user_input TEXT,
        model TEXT,
        input_tokens_total INTEGER NOT NULL,
        input_tokens_cache_read INTEGER NOT NULL,
        input_tokens_cache_write INTEGER NOT NULL,
        output_tokens_total INTEGER NOT NULL,
        output_tokens_reasoning INTEGER NOT NULL,
        cost_usd REAL,
        reasoning_text TEXT,
        output_text TEXT,
        error_code TEXT,
        error_message TEXT
      );

      CREATE TABLE usage_tool_calls (
        turn_id TEXT NOT NULL REFERENCES usage_turns(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        output TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'needs_input')),
        PRIMARY KEY (turn_id, position)
      );

      CREATE INDEX usage_turns_workspace_seq_idx
        ON usage_turns(workspace_id, seq);
      CREATE INDEX usage_turns_session_seq_idx
        ON usage_turns(session_id, seq);
      CREATE INDEX usage_turns_conversation_seq_idx
        ON usage_turns(workspace_id, conversation_id, seq);
    `);
  },
};

// Owns the complete SQLite database used for durable workspace data. Conversation replay state and
// execution records remain separate concepts with separate tables, while opening this database
// guarantees that both schemas are ready and share the same durability and backup boundary.
import { mkdirSync } from "fs";
import path from "path";
import Database from "better-sqlite3";
import { WORKSPACES_ROOT } from "../infra/paths";

export const DATA_DB_FILE = path.join(/* turbopackIgnore: true */ WORKSPACES_ROOT, ".workspace.db");

type DataDbGlobal = typeof global & {
  _workspaceDataDb?: Database.Database;
  _workspaceDataDbFile?: string;
};

const g = global as DataDbGlobal;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT CHECK (kind IS NULL OR kind IN ('user', 'skill-call', 'scheduled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_message_at TEXT NOT NULL,
    messages_json TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS conversations_workspace_recent_idx
    ON conversations(workspace_id, last_message_at DESC, updated_at DESC);

  CREATE TABLE IF NOT EXISTS usage_turns (
    -- seq preserves recording order when timestamps are equal. AUTOINCREMENT prevents reuse if a
    -- future retention policy removes the newest rows.
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    conversation_id TEXT,
    workspace_id TEXT NOT NULL,
    workspace_name TEXT NOT NULL,
    origin TEXT,
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

  CREATE TABLE IF NOT EXISTS usage_tool_calls (
    turn_id TEXT NOT NULL REFERENCES usage_turns(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    output TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'needs_input')),
    PRIMARY KEY (turn_id, position)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS usage_turns_workspace_seq_idx
    ON usage_turns(workspace_id, seq);
  CREATE INDEX IF NOT EXISTS usage_turns_session_seq_idx
    ON usage_turns(session_id, seq);
  CREATE INDEX IF NOT EXISTS usage_turns_conversation_seq_idx
    ON usage_turns(workspace_id, conversation_id, seq);
`;

export function dataDb(): Database.Database {
  if (g._workspaceDataDb && g._workspaceDataDbFile === DATA_DB_FILE) return g._workspaceDataDb;
  if (g._workspaceDataDb?.open) g._workspaceDataDb.close();

  mkdirSync(path.dirname(DATA_DB_FILE), { recursive: true });
  const conn = new Database(DATA_DB_FILE);
  try {
    conn.pragma("journal_mode = WAL");
    conn.pragma("synchronous = FULL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
    conn.exec(SCHEMA_SQL);
  } catch (err) {
    conn.close();
    throw err;
  }

  g._workspaceDataDb = conn;
  g._workspaceDataDbFile = DATA_DB_FILE;
  return conn;
}

export function invalidateDataDb(): void {
  if (g._workspaceDataDb?.open) g._workspaceDataDb.close();
  delete g._workspaceDataDb;
  delete g._workspaceDataDbFile;
}

export async function backupDataDb(destination: string): Promise<void> {
  if (!destination.trim()) throw new Error("A data backup destination is required.");
  const resolved = path.resolve(destination);
  if (resolved === path.resolve(DATA_DB_FILE)) throw new Error("The data backup must not overwrite the live database.");
  mkdirSync(path.dirname(resolved), { recursive: true });
  await dataDb().backup(resolved);
}

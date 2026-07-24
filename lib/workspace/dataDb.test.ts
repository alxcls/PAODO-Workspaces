import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "datadb-test-"));
const DB_FILE = path.join(ROOT, ".workspace.db");

type ClosableDb = { open: boolean; close(): void };

function closeGlobalDb(): void {
  const g = global as Record<string, unknown>;
  const conn = g._workspaceDataDb as ClosableDb | undefined;
  if (conn?.open) conn.close();
  delete g._workspaceDataDb;
  delete g._workspaceDataDbFile;
}

async function freshDataDb() {
  closeGlobalDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.WORKSPACES_ROOT = ROOT;
  vi.resetModules();
  return import("./dataDb");
}

beforeEach(closeGlobalDb);

afterAll(() => {
  closeGlobalDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("dataDb", () => {
  it("creates the complete schema when the database is opened", async () => {
    const { dataDb } = await freshDataDb();
    const conn = dataDb();
    const objects = conn
      .prepare(
        `
          SELECT type, name
          FROM sqlite_master
          WHERE name IN (
            'conversations',
            'conversations_workspace_recent_idx',
            'usage_turns',
            'usage_tool_calls',
            'usage_turns_workspace_seq_idx',
            'usage_turns_session_seq_idx',
            'usage_turns_conversation_seq_idx'
          )
          ORDER BY name
        `,
      )
      .all();

    expect(objects).toEqual([
      { type: "table", name: "conversations" },
      { type: "index", name: "conversations_workspace_recent_idx" },
      { type: "table", name: "usage_tool_calls" },
      { type: "table", name: "usage_turns" },
      { type: "index", name: "usage_turns_conversation_seq_idx" },
      { type: "index", name: "usage_turns_session_seq_idx" },
      { type: "index", name: "usage_turns_workspace_seq_idx" },
    ]);
  });

  it("backs up the whole shared database and refuses to overwrite the live file", async () => {
    const { backupDataDb, dataDb } = await freshDataDb();
    const conn = dataDb();
    conn
      .prepare(
        `
          INSERT INTO conversations (
            workspace_id, id, title, kind, created_at, updated_at, last_message_at, messages_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run("w1", "c1", "Chat", "user", "2026-01-01", "2026-01-01", "2026-01-01", "[]");
    conn
      .prepare(
        `
          INSERT INTO usage_turns (
            id, session_id, conversation_id, workspace_id, workspace_name, timestamp,
            input_tokens_total, input_tokens_cache_read, input_tokens_cache_write,
            output_tokens_total, output_tokens_reasoning
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run("t1", "s1", "c1", "w1", "Workspace", "2026-01-01", 12, 0, 0, 4, 0);

    const backupFile = path.join(ROOT, "backups", "workspace.db");
    await backupDataDb(backupFile);

    const backup = new Database(backupFile, { readonly: true });
    expect(backup.prepare("SELECT id FROM conversations").get()).toEqual({ id: "c1" });
    expect(backup.prepare("SELECT id FROM usage_turns").get()).toEqual({ id: "t1" });
    backup.close();
    await expect(backupDataDb(DB_FILE)).rejects.toThrow("must not overwrite");
  });
});

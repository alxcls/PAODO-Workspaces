import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { DATABASE_MIGRATIONS, migrateDatabase, type Migration } from "./migrations";

// Derived, not hand-written: a new migration must move these assertions on its own, or they quietly
// stop covering the newest schema version.
const LATEST_VERSION = DATABASE_MIGRATIONS.at(-1)!.version;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "database-test-"));
const DB_FILE = path.join(ROOT, ".paodo.db");

type ClosableDb = { open: boolean; close(): void };

function closeGlobalDb(): void {
  const g = global as Record<string, unknown>;
  const conn = g._paodoDataDb as ClosableDb | undefined;
  if (conn?.open) conn.close();
  delete g._paodoDataDb;
  delete g._paodoDataDbFile;
}

async function freshDatabase() {
  closeGlobalDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.WORKSPACES_ROOT = ROOT;
  vi.resetModules();
  return import("./database");
}

beforeEach(closeGlobalDb);

afterAll(() => {
  closeGlobalDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("appDataDb", () => {
  it("runs the canonical migrations when a fresh database is opened", async () => {
    const { appDataDb } = await freshDatabase();
    const conn = appDataDb();
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
    expect(conn.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
  });

  it("refuses to expose or cache a database created by newer application code", async () => {
    closeGlobalDb();
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
    const newer = new Database(DB_FILE);
    newer.pragma(`user_version = ${LATEST_VERSION + 1}`);
    newer.close();

    process.env.WORKSPACES_ROOT = ROOT;
    vi.resetModules();
    const { appDataDb } = await import("./database");

    expect(() => appDataDb()).toThrow("newer than the supported version");
    expect((global as Record<string, unknown>)._paodoDataDb).toBeUndefined();
  });

  it("uses rowid storage for large records and validates usage origins", async () => {
    const { appDataDb } = await freshDatabase();
    const conn = appDataDb();
    const tableDefinitions = conn
      .prepare(
        `
          SELECT name, sql
          FROM sqlite_master
          WHERE type = 'table' AND name IN ('conversations', 'usage_tool_calls')
          ORDER BY name
        `,
      )
      .all() as Array<{ name: string; sql: string }>;

    expect(tableDefinitions.map(({ name }) => name)).toEqual(["conversations", "usage_tool_calls"]);
    for (const { sql } of tableDefinitions) {
      expect(sql).not.toContain("WITHOUT ROWID");
    }

    const insertUsage = conn.prepare(
      `
        INSERT INTO usage_turns (
          id, session_id, workspace_id, workspace_name, origin, timestamp,
          input_tokens_total, input_tokens_cache_read, input_tokens_cache_write,
          output_tokens_total, output_tokens_reasoning
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    expect(() =>
      insertUsage.run("invalid-origin", "s1", "w1", "Workspace", "unknown", "2026-01-01", 0, 0, 0, 0, 0),
    ).toThrow();
  });

  it("backs up the whole database and refuses to overwrite the live file", async () => {
    const { appDataDb, backupAppDataDb } = await freshDatabase();
    const conn = appDataDb();
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

    const backupFile = path.join(ROOT, "backups", "paodo.db");
    await backupAppDataDb(backupFile);

    const backup = new Database(backupFile, { readonly: true });
    expect(backup.prepare("SELECT id FROM conversations").get()).toEqual({ id: "c1" });
    expect(backup.prepare("SELECT id FROM usage_turns").get()).toEqual({ id: "t1" });
    expect(backup.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    backup.close();
    await expect(backupAppDataDb(DB_FILE)).rejects.toThrow("must not overwrite");
  });
});

describe("migrateDatabase", () => {
  const v1: Migration = {
    version: 1,
    name: "records",
    up(db) {
      db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO records (id, value) VALUES (?, ?)").run(1, "preserved");
    },
  };

  it("upgrades in order, preserves data, and is idempotent", () => {
    const conn = new Database(":memory:");
    migrateDatabase(conn, [v1]);

    let v2Runs = 0;
    const v2: Migration = {
      version: 2,
      name: "record-label",
      up(db) {
        v2Runs++;
        db.exec("ALTER TABLE records ADD COLUMN label TEXT");
        db.prepare("UPDATE records SET label = ? WHERE id = ?").run("migrated", 1);
      },
    };

    migrateDatabase(conn, [v1, v2]);
    migrateDatabase(conn, [v1, v2]);

    expect(conn.prepare("SELECT * FROM records").get()).toEqual({
      id: 1,
      value: "preserved",
      label: "migrated",
    });
    expect(conn.pragma("user_version", { simple: true })).toBe(2);
    expect(v2Runs).toBe(1);
    conn.close();
  });

  it("rolls back a failed migration and leaves the previous version usable", () => {
    const conn = new Database(":memory:");
    migrateDatabase(conn, [v1]);
    const failing: Migration = {
      version: 2,
      name: "failing-change",
      up(db) {
        db.exec("ALTER TABLE records ADD COLUMN unfinished TEXT");
        throw new Error("migration failed");
      },
    };

    expect(() => migrateDatabase(conn, [v1, failing])).toThrow("migration failed");
    expect(conn.pragma("user_version", { simple: true })).toBe(1);
    expect(conn.prepare("PRAGMA table_info(records)").all()).not.toContainEqual(
      expect.objectContaining({ name: "unfinished" }),
    );
    expect(conn.prepare("SELECT value FROM records WHERE id = 1").get()).toEqual({ value: "preserved" });
    conn.close();
  });

  it("rejects a database created by newer application code", () => {
    const conn = new Database(":memory:");
    conn.pragma("user_version = 2");
    expect(() => migrateDatabase(conn, [v1])).toThrow("newer than the supported version");
    conn.close();
  });

  it("rejects missing or duplicate migration versions", () => {
    const conn = new Database(":memory:");
    expect(() => migrateDatabase(conn, [{ ...v1, version: 2 }])).toThrow("must be contiguous");
    conn.close();
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { DATABASE_MIGRATIONS, migrateDatabase, type Migration } from "./migrations";

// Derived, not hand-written: a new migration must move this on its own, or it quietly stops
// covering the newest schema version.
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
            'sessions',
            'sessions_workspace_started_idx',
            'sessions_conversation_idx',
            'turns',
            'turns_session_seq_idx'
          )
          ORDER BY name
        `,
      )
      .all();

    expect(objects).toEqual([
      { type: "table", name: "conversations" },
      { type: "index", name: "conversations_workspace_recent_idx" },
      { type: "table", name: "sessions" },
      { type: "index", name: "sessions_conversation_idx" },
      { type: "index", name: "sessions_workspace_started_idx" },
      { type: "table", name: "turns" },
      { type: "index", name: "turns_session_seq_idx" },
    ]);
    expect(conn.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
  });

  it("uses rowid storage for large records and validates usage origins", async () => {
    const { appDataDb } = await freshDatabase();
    const conn = appDataDb();
    const tableDefinitions = conn
      .prepare(
        `
          SELECT name, sql
          FROM sqlite_master
          WHERE type = 'table' AND name IN ('conversations', 'sessions', 'turns')
          ORDER BY name
        `,
      )
      .all() as Array<{ name: string; sql: string }>;

    expect(tableDefinitions.map(({ name }) => name)).toEqual(["conversations", "sessions", "turns"]);
    for (const { sql } of tableDefinitions) {
      expect(sql).not.toContain("WITHOUT ROWID");
    }

    const insertSession = conn.prepare(
      `
        INSERT INTO sessions (
          id, workspace_id, workspace_name, origin, system_prompt, started_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    );
    expect(() => insertSession.run("s1", "w1", "Workspace", "unknown", "prompt", "2026-01-01", "running")).toThrow();
  });

  it("backs up the whole database and refuses to overwrite the live file", async () => {
    const { appDataDb, backupAppDataDb } = await freshDatabase();
    const conn = appDataDb();
    conn
      .prepare(
        `
          INSERT INTO conversations (
            workspace_id, id, title, created_at, updated_at, last_message_at, messages_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run("w1", "c1", "Chat", "2026-01-01", "2026-01-01", "2026-01-01", "[]");
    conn
      .prepare(
        `
          INSERT INTO sessions (
            id, workspace_id, workspace_name, conversation_id, origin,
            system_prompt, started_at, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run("s1", "w1", "Workspace", "c1", "chat", "# Prompt", "2026-01-01", "running");
    conn
      .prepare(
        `
          INSERT INTO turns (
            id, session_id, timestamp,
            input_tokens_total, input_tokens_cache_read, input_tokens_cache_write,
            output_tokens_total, output_tokens_reasoning
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run("t1", "s1", "2026-01-01", 12, 0, 0, 4, 0);

    const backupFile = path.join(ROOT, "backups", "paodo.db");
    await backupAppDataDb(backupFile);

    const backup = new Database(backupFile, { readonly: true });
    expect(backup.prepare("SELECT id FROM conversations").get()).toEqual({ id: "c1" });
    expect(backup.prepare("SELECT system_prompt FROM sessions WHERE id = 's1'").get()).toEqual({
      system_prompt: "# Prompt",
    });
    expect(backup.prepare("SELECT id FROM turns").get()).toEqual({ id: "t1" });
    expect(backup.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    backup.close();
    await expect(backupAppDataDb(DB_FILE)).rejects.toThrow("must not overwrite");
  });
});

describe("migrateDatabase", () => {
  const records: Migration = {
    version: 1,
    name: "records",
    up(db) {
      db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO records (id, value) VALUES (?, ?)").run(1, "preserved");
    },
  };

  it("applies the baseline to a fresh database", () => {
    const conn = new Database(":memory:");

    migrateDatabase(conn, DATABASE_MIGRATIONS);

    expect(conn.pragma("user_version", { simple: true })).toBe(1);
    expect(
      conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all(),
    ).toEqual([{ name: "conversations" }, { name: "sessions" }, { name: "turns" }]);
    conn.close();
  });

  // The baseline sweeps by name from sqlite_master, so it rebuilds a file left by an older shape
  // without naming that shape's tables.
  it("rebuilds a database an unrelated older schema left behind", () => {
    const conn = new Database(":memory:");
    conn.exec(`
      CREATE TABLE usage_turns (id TEXT PRIMARY KEY, cost_usd REAL);
      CREATE TABLE usage_tool_calls (turn_id TEXT REFERENCES usage_turns(id), name TEXT);
    `);
    conn.prepare("INSERT INTO usage_turns (id, cost_usd) VALUES ('t1', 0.5)").run();

    migrateDatabase(conn, DATABASE_MIGRATIONS);

    expect(
      conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all(),
    ).toEqual([{ name: "conversations" }, { name: "sessions" }, { name: "turns" }]);
    conn.close();
  });

  it("upgrades in order, preserves data, and is idempotent", () => {
    const conn = new Database(":memory:");
    migrateDatabase(conn, [records]);

    let labelRuns = 0;
    const label: Migration = {
      version: 2,
      name: "record-label",
      up(db) {
        labelRuns++;
        db.exec("ALTER TABLE records ADD COLUMN label TEXT");
        db.prepare("UPDATE records SET label = ? WHERE id = ?").run("migrated", 1);
      },
    };

    migrateDatabase(conn, [records, label]);
    migrateDatabase(conn, [records, label]);

    expect(conn.prepare("SELECT * FROM records").get()).toEqual({ id: 1, value: "preserved", label: "migrated" });
    expect(conn.pragma("user_version", { simple: true })).toBe(2);
    expect(labelRuns).toBe(1);
    conn.close();
  });

  it("rolls back a failed migration and leaves the previous version usable", () => {
    const conn = new Database(":memory:");
    migrateDatabase(conn, [records]);
    const failing: Migration = {
      version: 2,
      name: "failing-change",
      up(db) {
        db.exec("ALTER TABLE records ADD COLUMN unfinished TEXT");
        throw new Error("migration failed");
      },
    };

    expect(() => migrateDatabase(conn, [records, failing])).toThrow("migration failed");
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
    expect(() => migrateDatabase(conn, [records])).toThrow("newer than the supported version");
    conn.close();
  });

  it("rejects missing or duplicate migration versions", () => {
    const conn = new Database(":memory:");
    expect(() => migrateDatabase(conn, [{ ...records, version: 2 }])).toThrow("must be contiguous");
    conn.close();
  });
});

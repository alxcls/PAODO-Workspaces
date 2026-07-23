// SQLite is the sole usage store. These tests cover transactional full-content writes, lightweight
// indexed reads, one-time JSONL migration, persistence across process/module restarts, and safe
// online backups.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "usagestore-test-"));
const DB_FILE = path.join(ROOT, ".usage.db");
const LEGACY_FILE = path.join(ROOT, ".usage.jsonl");

type ClosableDb = { open: boolean; close(): void };

function closeGlobalDb() {
  const g = global as Record<string, unknown>;
  const conn = g._usageDb as ClosableDb | undefined;
  if (conn?.open) conn.close();
  delete g._usageDb;
  delete g._usageDbFile;
}

afterAll(() => {
  closeGlobalDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function loadStore() {
  process.env.WORKSPACES_ROOT = ROOT;
  vi.resetModules();
  return import("./usageStore");
}

async function freshStore() {
  closeGlobalDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  return loadStore();
}

function baseTurn(over: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    workspaceId: "w1",
    workspaceName: "WS",
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 2,
    cachedInputTokens: 60,
    cacheCreationTokens: 0,
    toolCalls: [],
    ...over,
  };
}

describe("usageStore", () => {
  beforeEach(() => {
    closeGlobalDb();
    vi.resetModules();
  });

  it("persists complete turns in SQLite without creating a new JSONL journal", async () => {
    const store = await freshStore();
    store.appendUsage(
      baseTurn({
        userInput: "fix the bug",
        reasoningText: "I should read the file first",
        outputText: "Done — the bug was a missing null check.",
        toolCalls: [{ name: "file_read", args: { file_path: "a.ts" }, output: "line1\nline2", status: "ok" }],
      }),
    );

    expect(fs.existsSync(DB_FILE)).toBe(true);
    expect(fs.existsSync(LEGACY_FILE)).toBe(false);
    expect(store.getSessionDetail("s1")).toMatchObject([
      {
        userInput: "fix the bug",
        reasoningText: "I should read the file first",
        outputText: "Done — the bug was a missing null check.",
        toolCalls: [
          {
            name: "file_read",
            args: { file_path: "a.ts" },
            output: "line1\nline2",
            status: "ok",
          },
        ],
      },
    ]);
  });

  it("commits a turn and all of its ordered tool calls atomically", async () => {
    const store = await freshStore();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    store.appendUsage(
      baseTurn({
        toolCalls: [{ name: "bad_args", args: circular, output: "never committed", status: "error" }],
      }),
    );

    expect(store.listUsageLight()).toEqual([]);
    const conn = new Database(DB_FILE, { readonly: true });
    expect((conn.prepare("SELECT count(*) AS count FROM usage_turns").get() as { count: number }).count).toBe(0);
    expect((conn.prepare("SELECT count(*) AS count FROM usage_tool_calls").get() as { count: number }).count).toBe(0);
    conn.close();
  });

  it("records a terminal error even when the run completed no model turn", async () => {
    const store = await freshStore();
    store.recordRunError(
      { sessionId: "failed-session", workspaceId: "w1", workspaceName: "WS", origin: "agent" },
      { code: "TIMEOUT", message: "The workspace exceeded its limit." },
      "do the work",
    );

    expect(store.getSessionDetail("failed-session")).toMatchObject([
      {
        userInput: "do the work",
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: [],
        error: { code: "TIMEOUT", message: "The workspace exceeded its limit." },
      },
    ]);
    expect(store.listUsageLight()[0].error).toEqual({
      code: "TIMEOUT",
      message: "The workspace exceeded its limit.",
    });
  });

  it("selects only lightweight fields for the dashboard list", async () => {
    const store = await freshStore();
    store.appendUsage(
      baseTurn({
        userInput: "secret prompt",
        reasoningText: "secret reasoning",
        outputText: "secret response",
        toolCalls: [{ name: "execute_command", args: { command: "ls" }, output: "huge output", status: "error" }],
      }),
    );

    const light = store.listUsageLight();
    const record = light[0] as unknown as Record<string, unknown>;
    expect(record.userInput).toBeUndefined();
    expect(record.reasoningText).toBeUndefined();
    expect(record.outputText).toBeUndefined();
    expect(light[0].inputTokens).toBe(100);
    expect(light[0].toolCalls).toEqual([{ name: "execute_command", status: "error" }]);
  });

  it("returns session detail oldest-first and tool calls in execution order", async () => {
    const store = await freshStore();
    store.appendUsage(
      baseTurn({
        toolCalls: [
          { name: "first", args: {}, output: "1", status: "ok" },
          { name: "second", args: {}, output: "2", status: "needs_input" },
        ],
      }),
    );
    store.appendUsage(
      baseTurn({
        toolCalls: [{ name: "third", args: {}, output: "3", status: "ok" }],
      }),
    );

    expect(store.getSessionDetail("s1").flatMap((turn) => turn.toolCalls.map((tool) => tool.name))).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("filters the lightweight list by workspace", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({ sessionId: "a", workspaceId: "w1" }));
    store.appendUsage(baseTurn({ sessionId: "b", workspaceId: "w2" }));

    expect(store.listUsageLight("w1").map((record) => record.sessionId)).toEqual(["a"]);
    expect(store.listUsageLight("w2").map((record) => record.sessionId)).toEqual(["b"]);
  });

  it("freezes priced cost when the record is written", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({ model: "chatgpt-4o-latest" }));

    expect(store.listUsageLight()[0].cost).toBeTypeOf("number");
    expect(store.getSessionDetail("s1")[0].cost).toBe(store.listUsageLight()[0].cost);
  });

  it("retains records beyond the dashboard response cap", async () => {
    const store = await freshStore();
    for (let i = 0; i < 5001; i++) {
      store.appendUsage(baseTurn({ sessionId: `s${i}` }));
    }

    expect(store.listUsageLight()).toHaveLength(5000);
    const conn = new Database(DB_FILE, { readonly: true });
    expect((conn.prepare("SELECT count(*) AS count FROM usage_turns").get() as { count: number }).count).toBe(5001);
    conn.close();
  });

  it("survives a fresh process/module connection without an in-memory mirror", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({ outputText: "persist me" }));

    closeGlobalDb();
    const reopened = await loadStore();
    expect(reopened.getSessionDetail("s1")[0].outputText).toBe("persist me");
  });

  it("surfaces database corruption without deleting or replacing the damaged file", async () => {
    await freshStore();
    closeGlobalDb();
    const damaged = Buffer.from("not a sqlite database");
    fs.writeFileSync(DB_FILE, damaged);

    const store = await loadStore();
    expect(() => store.listUsageLight()).toThrow();
    expect(fs.readFileSync(DB_FILE)).toEqual(damaged);
  });

  it("imports legacy JSONL once, including heavy content and default tool status", async () => {
    await freshStore();
    closeGlobalDb();
    fs.rmSync(DB_FILE, { force: true });
    fs.rmSync(`${DB_FILE}-shm`, { force: true });
    fs.rmSync(`${DB_FILE}-wal`, { force: true });
    fs.writeFileSync(
      LEGACY_FILE,
      [
        JSON.stringify({
          id: "legacy-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          ...baseTurn({
            reasoningText: "legacy reasoning",
            toolCalls: [{ name: "legacy_tool", args: { a: 1 }, output: "legacy output" }],
          }),
        }),
        "{malformed",
      ].join("\n") + "\n",
    );

    const store = await loadStore();
    expect(store.getSessionDetail("s1")).toMatchObject([
      {
        id: "legacy-1",
        reasoningText: "legacy reasoning",
        toolCalls: [{ name: "legacy_tool", args: { a: 1 }, output: "legacy output", status: "ok" }],
      },
    ]);
    expect(fs.existsSync(LEGACY_FILE)).toBe(true);

    closeGlobalDb();
    const reopened = await loadStore();
    expect(reopened.listUsageLight()).toHaveLength(1);
  });

  it("archives the known legacy metrics projection and rebuilds complete rows from JSONL", async () => {
    await freshStore();
    closeGlobalDb();
    fs.rmSync(DB_FILE, { force: true });
    fs.rmSync(`${DB_FILE}-shm`, { force: true });
    fs.rmSync(`${DB_FILE}-wal`, { force: true });

    const projection = new Database(DB_FILE);
    projection.exec(`
      CREATE TABLE usage_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        conversation_id TEXT,
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        origin TEXT,
        model TEXT,
        timestamp TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cost REAL,
        tool_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT
      );
      INSERT INTO usage_turns VALUES (
        'legacy-projection-row', 's1', NULL, 'w1', 'WS', 'chat', 'chatgpt-4o-latest',
        '2026-01-01T00:00:00.000Z', 100, 10, 60, 0, 2, 0.01, 1, NULL, NULL
      );
    `);
    projection.close();
    fs.writeFileSync(
      LEGACY_FILE,
      `${JSON.stringify({
        id: "legacy-projection-row",
        timestamp: "2026-01-01T00:00:00.000Z",
        ...baseTurn({
          userInput: "complete prompt",
          outputText: "complete response",
          toolCalls: [{ name: "read", args: { path: "a.ts" }, output: "contents", status: "ok" }],
        }),
      })}\n`,
    );

    const store = await loadStore();

    expect(store.getSessionDetail("s1")).toMatchObject([
      {
        id: "legacy-projection-row",
        userInput: "complete prompt",
        outputText: "complete response",
        toolCalls: [{ name: "read", args: { path: "a.ts" }, output: "contents", status: "ok" }],
      },
    ]);
    const archive = fs.readdirSync(ROOT).find((file) => file.startsWith(".usage.db.legacy-projection"));
    expect(archive).toBeDefined();
    const archived = new Database(path.join(ROOT, archive!), { readonly: true });
    expect(archived.prepare("SELECT id FROM usage_turns").get()).toEqual({ id: "legacy-projection-row" });
    archived.close();
  });

  it("creates a consistent backup containing complete text and tool output", async () => {
    const store = await freshStore();
    store.appendUsage(
      baseTurn({
        userInput: "backup prompt",
        outputText: "backup response",
        toolCalls: [{ name: "exec", args: { command: "pwd" }, output: "/workspace", status: "ok" }],
      }),
    );
    const backupFile = path.join(ROOT, "backups", "usage.db");

    await store.backupUsage(backupFile);

    const backup = new Database(backupFile, { readonly: true });
    expect(backup.prepare("SELECT user_input, output_text FROM usage_turns").get()).toEqual({
      user_input: "backup prompt",
      output_text: "backup response",
    });
    expect(backup.prepare("SELECT args_json, output FROM usage_tool_calls").get()).toEqual({
      args_json: '{"command":"pwd"}',
      output: "/workspace",
    });
    backup.close();
  });

  it("refuses to overwrite the live database with a backup", async () => {
    const store = await freshStore();
    await expect(store.backupUsage(DB_FILE)).rejects.toThrow("must not overwrite");
  });
});

// SQLite is the sole usage store. These tests cover transactional full-content writes, lightweight
// indexed reads, persistence across process/module restarts, and safe online backups.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "usagestore-test-"));
const DB_FILE = path.join(ROOT, ".usage.db");
const JSONL_FILE = path.join(ROOT, ".usage.jsonl");

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
    expect(fs.existsSync(JSONL_FILE)).toBe(false);
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

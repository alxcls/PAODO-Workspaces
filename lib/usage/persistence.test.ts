// Round-trip tests for the usage store: ./record.ts writes, ./rows.ts maps, ./queries.ts reads.
// Deliberately one file rather than record.test.ts + queries.test.ts — every assertion here is
// write-then-read (there is no way to observe an insert except by querying it), so a per-module split
// would duplicate the SQLite harness below without isolating anything.
//
// Covers transactional full-content writes, lightweight indexed reads, and persistence across
// process/module restarts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "usagestore-test-"));
const DB_FILE = path.join(ROOT, ".paodo.db");
const JSONL_FILE = path.join(ROOT, ".usage.jsonl");

type ClosableDb = { open: boolean; close(): void };

function closeGlobalDb() {
  const g = global as Record<string, unknown>;
  const conn = g._paodoDataDb as ClosableDb | undefined;
  if (conn?.open) conn.close();
  delete g._paodoDataDb;
  delete g._paodoDataDbFile;
}

afterAll(() => {
  closeGlobalDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// Re-imports both halves after resetting the module registry, so each test gets a store bound to a
// freshly opened connection. Merged into one object because the tests exercise them as one unit.
async function loadStore() {
  process.env.WORKSPACES_ROOT = ROOT;
  vi.resetModules();
  const [record, queries] = await Promise.all([import("./record"), import("./queries")]);
  return { ...record, ...queries };
}

async function freshStore() {
  closeGlobalDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const store = await loadStore();
  startTestSession(store);
  return store;
}

function baseTurn(over: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    inputTokensTotal: 100,
    inputTokensCacheRead: 60,
    inputTokensCacheWrite: 0,
    outputTokensTotal: 10,
    outputTokensReasoning: 2,
    toolCalls: [],
    ...over,
  };
}

type UsageStore = Awaited<ReturnType<typeof loadStore>>;

function startTestSession(store: UsageStore, over: Record<string, unknown> = {}) {
  store.startUsageSession({
    id: "s1",
    workspaceId: "w1",
    workspaceName: "WS",
    origin: "manual",
    systemPrompt: "",
    ...over,
  });
}

/** getSessionDetail is nullable for the 404 path; every test here writes the session first. */
function detailOf(store: UsageStore, sessionId: string) {
  const detail = store.getSessionDetail(sessionId);
  if (!detail) throw new Error(`expected stored session detail for ${sessionId}`);
  return detail;
}

async function freshEmptyStore() {
  closeGlobalDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  return loadStore();
}

describe("usageStore", () => {
  beforeEach(() => {
    closeGlobalDb();
    vi.resetModules();
  });

  it("stores the resolved Markdown system prompt and run provenance once on the session", async () => {
    const store = await freshEmptyStore();
    store.startUsageSession({
      id: "s1",
      workspaceId: "w1",
      workspaceName: "WS",
      conversationId: "c1",
      origin: "scheduled",
      userInput: "run the report",
      systemPrompt: "# System\n\nFollow the workspace instructions.",
    });
    store.appendUsage(baseTurn({ sessionId: "s1", conversationId: "c1" }));
    store.finishUsageSession("s1", "success");

    const conn = new Database(DB_FILE, { readonly: true });
    expect(
      conn.prepare("SELECT origin, user_input, system_prompt, status FROM sessions WHERE id = 's1'").get(),
    ).toEqual({
      origin: "scheduled",
      user_input: "run the report",
      system_prompt: "# System\n\nFollow the workspace instructions.",
      status: "success",
    });
    expect(
      (conn.prepare("SELECT count(*) AS count FROM turns WHERE session_id = 's1'").get() as { count: number }).count,
    ).toBe(1);
    conn.close();
  });

  it("persists complete turns in SQLite without creating a new JSONL journal", async () => {
    const store = await freshEmptyStore();
    startTestSession(store, { userInput: "fix the bug" });
    store.appendUsage(
      baseTurn({
        reasoningText: "I should read the file first",
        outputText: "Done — the bug was a missing null check.",
        toolCalls: [{ name: "file_read", args: { file_path: "a.ts" }, output: "line1\nline2", status: "ok" }],
      }),
    );

    expect(fs.existsSync(DB_FILE)).toBe(true);
    expect(fs.existsSync(JSONL_FILE)).toBe(false);
    expect(detailOf(store, "s1")).toMatchObject({
      session: { userInput: "fix the bug" },
      turns: [
        {
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
      ],
    });
  });

  // Tool calls are serialized before the INSERT runs, so unserializable arguments abort the write
  // outright rather than storing a turn whose tool calls went missing.
  it("writes no turn at all when its tool arguments cannot be serialized", async () => {
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
    expect((conn.prepare("SELECT count(*) AS count FROM turns").get() as { count: number }).count).toBe(0);
    expect((conn.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number }).count).toBe(1);
    conn.close();
  });

  it("records a terminal error even when the run completed no model turn", async () => {
    const store = await freshEmptyStore();
    startTestSession(store, { id: "failed-session", origin: "agent", userInput: "do the work" });
    store.recordRunError("failed-session", { code: "TIMEOUT", message: "The workspace exceeded its limit." });

    expect(detailOf(store, "failed-session").turns).toEqual([]);
    const conn = new Database(DB_FILE, { readonly: true });
    expect(
      conn
        .prepare("SELECT user_input, status, error_code, error_message FROM sessions WHERE id = ?")
        .get("failed-session"),
    ).toEqual({
      user_input: "do the work",
      status: "timeout",
      error_code: "TIMEOUT",
      error_message: "The workspace exceeded its limit.",
    });
    conn.close();
  });

  it("generates an id when an optional id is explicitly undefined", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({ id: undefined }));

    expect(detailOf(store, "s1").turns[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
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
    expect(light[0].inputTokensTotal).toBe(100);
    expect(light[0].toolCalls).toEqual([{ name: "execute_command", status: "error" }]);
  });

  it("reports whether each run's conversation still exists, keeping the id either way", async () => {
    const store = await freshEmptyStore();
    const conversations = await import("../conversations/store");
    const live = conversations.createConversation("w1");
    startTestSession(store, { id: "kept", conversationId: live.id });
    startTestSession(store, { id: "orphan", conversationId: "deleted-conversation" });
    startTestSession(store, { id: "external" });
    store.appendUsage(baseTurn({ sessionId: "kept" }));
    store.appendUsage(baseTurn({ sessionId: "orphan" }));
    store.appendUsage(baseTurn({ sessionId: "external" }));

    const bySession = new Map(store.listUsageLight().map((r) => [r.sessionId, r]));
    expect(bySession.get("kept")).toMatchObject({ conversationId: live.id, conversationLive: true });
    expect(bySession.get("orphan")).toMatchObject({ conversationId: "deleted-conversation", conversationLive: false });
    expect(bySession.get("external")).toMatchObject({ conversationId: undefined, conversationLive: false });

    // Deleting the workspace's conversations leaves its execution records, ids included.
    conversations.deleteWorkspaceConversations("w1");
    const after = store.listUsageLight();
    expect(after).toHaveLength(3);
    expect(after.every((r) => r.conversationLive === false)).toBe(true);
    expect(after.find((r) => r.sessionId === "kept")?.conversationId).toBe(live.id);
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

    expect(detailOf(store, "s1").turns.flatMap((turn) => turn.toolCalls.map((tool) => tool.name))).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("preserves recording order for turns that share a timestamp", async () => {
    const store = await freshEmptyStore();
    startTestSession(store, { id: "caller", workspaceId: "w-caller", userInput: "call the callee" });
    startTestSession(store, { id: "callee", workspaceId: "w-callee", userInput: "do the work" });
    // Freeze the clock so every turn gets an identical millisecond timestamp — the case fast or
    // zero-token turns hit in production. Order must come from the recording sequence, not the
    // timestamp or the random UUID tiebreaker.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    try {
      // A caller workspace run that invokes a callee workspace run, recorded in that order.
      store.appendUsage(baseTurn({ sessionId: "caller", id: "caller-1" }));
      store.appendUsage(baseTurn({ sessionId: "callee", id: "callee-1" }));
      store.appendUsage(baseTurn({ sessionId: "caller", id: "caller-2" }));
    } finally {
      vi.useRealTimers();
    }

    // The dashboard list is newest-first in recording order, regardless of the shared timestamp.
    expect(store.listUsageLight().map((r) => r.sessionId)).toEqual(["caller", "callee", "caller"]);
    // The caller's own drawer keeps its two turns in the order they ran, and drops the callee's.
    expect(detailOf(store, "caller").turns.map((t) => t.id)).toEqual(["caller-1", "caller-2"]);
  });

  it("filters the lightweight list by workspace", async () => {
    const store = await freshEmptyStore();
    startTestSession(store, { id: "a", workspaceId: "w1" });
    startTestSession(store, { id: "b", workspaceId: "w2" });
    store.appendUsage(baseTurn({ sessionId: "a" }));
    store.appendUsage(baseTurn({ sessionId: "b" }));

    expect(store.listUsageLight("w1").map((record) => record.sessionId)).toEqual(["a"]);
    expect(store.listUsageLight("w2").map((record) => record.sessionId)).toEqual(["b"]);
  });

  it("keeps per-turn detail while projecting a session total onto its visible output", async () => {
    const store = await freshEmptyStore();
    startTestSession(store, { id: "run-1", conversationId: "conv-1" });
    store.recordTurnUsage("run-1", {
      turnId: "turn-tool",
      inputTokensTotal: 100,
      inputTokensCacheRead: 40,
      inputTokensCacheWrite: 0,
      outputTokensTotal: 10,
      outputTokensReasoning: 0,
      outputText: "I will inspect it",
      toolCalls: [{ name: "file_read", args: { file_path: "a.txt" }, output: "body", status: "ok" }],
    });
    store.recordTurnUsage("run-1", {
      turnId: "turn-output",
      inputTokensTotal: 123,
      inputTokensCacheRead: 20,
      inputTokensCacheWrite: 0,
      outputTokensTotal: 45,
      outputTokensReasoning: 0,
      outputText: "Done",
      toolCalls: [],
    });

    expect(store.getConversationOutputTokens("w1", "conv-1")).toEqual(
      new Map([
        [
          "turn-output",
          {
            inputTokensTotal: 223,
            inputTokensCacheRead: 60,
            outputTokensTotal: 55,
          },
        ],
      ]),
    );
    expect(detailOf(store, "run-1").turns.map((turn) => turn.id)).toEqual(["turn-tool", "turn-output"]);
  });

  it("freezes priced cost when the record is written", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({ model: "chatgpt-4o-latest" }));

    expect(store.listUsageLight()[0].cost).toBeTypeOf("number");
    expect(detailOf(store, "s1").turns[0].cost).toBe(store.listUsageLight()[0].cost);
  });

  // Both read paths, because they build their SELECTs separately — one could carry the currency
  // while the other silently drops it, and a euro cost read back as dollars is invisibly wrong.
  it("round-trips the currency a euro-priced turn was billed in, on both read paths", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({ model: "qwen3.6-35b-a3b" }));

    expect(store.listUsageLight()[0].costCurrency).toBe("EUR");
    expect(detailOf(store, "s1").turns[0].costCurrency).toBe("EUR");
  });

  it("records a dollar-priced turn as dollars, so the two are told apart", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({ model: "chatgpt-4o-latest" }));

    expect(store.listUsageLight()[0].costCurrency).toBe("USD");
  });

  it("leaves an unpriced turn with no currency, since there is no amount to qualify", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({ model: "not-a-real-model" }));

    expect(store.listUsageLight()[0].cost).toBeUndefined();
    expect(store.listUsageLight()[0].costCurrency).toBeUndefined();
  });

  it("retains records beyond the dashboard response cap", async () => {
    const store = await freshStore();
    for (let i = 0; i < 5001; i++) {
      store.appendUsage(baseTurn());
    }

    expect(store.listUsageLight()).toHaveLength(5000);
    const conn = new Database(DB_FILE, { readonly: true });
    expect((conn.prepare("SELECT count(*) AS count FROM turns").get() as { count: number }).count).toBe(5001);
    conn.close();
  });

  it("survives a fresh process/module connection without an in-memory mirror", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({ outputText: "persist me" }));

    closeGlobalDb();
    const reopened = await loadStore();
    expect(detailOf(reopened, "s1").turns[0].outputText).toBe("persist me");
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
});

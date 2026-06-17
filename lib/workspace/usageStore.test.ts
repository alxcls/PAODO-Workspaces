// Usage is now append-only JSONL carrying user input, reasoning, and tool outputs. The
// behaviours that matter: appendUsage writes exactly one line per turn (no full-file rewrite),
// getSessionDetail round-trips the heavy content, and listUsageLight strips it for the list.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "usagestore-test-"));

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// The in-memory log is global-backed (survives Next.js hot-reloads), so it also survives
// vi.resetModules — clear it explicitly to isolate each test.
function clearGlobalLog() {
  const g = global as Record<string, unknown>;
  delete g._usage;
  delete g._usageFileLines;
}

// Fresh module instance per test with WORKSPACES_ROOT pointed at an empty temp dir, so the
// module-level file path and in-memory log start clean.
async function freshStore() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.WORKSPACES_ROOT = ROOT;
  clearGlobalLog();
  vi.resetModules();
  return import("./usageStore");
}

const FILE = path.join(ROOT, ".usage.jsonl");

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
  beforeEach(() => { vi.resetModules(); });

  it("appends one JSONL line per turn", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn());
    store.appendUsage(baseTurn());
    const lines = fs.readFileSync(FILE, "utf-8").split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).inputTokens).toBe(100);
  });

  it("round-trips user input, reasoning text, agent response, and tool output via getSessionDetail", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({
      userInput: "fix the bug",
      reasoningText: "I should read the file first",
      outputText: "Done — the bug was a missing null check.",
      toolCalls: [{ name: "file_read", args: { file_path: "a.ts" }, output: "line1\nline2", status: "ok" }],
    }));
    const detail = store.getSessionDetail("s1");
    expect(detail).toHaveLength(1);
    expect(detail[0].userInput).toBe("fix the bug");
    expect(detail[0].reasoningText).toBe("I should read the file first");
    expect(detail[0].outputText).toBe("Done — the bug was a missing null check.");
    expect(detail[0].toolCalls[0].output).toBe("line1\nline2");
    expect(detail[0].toolCalls[0].status).toBe("ok");
  });

  it("listUsageLight strips heavy content but keeps tokens and tool names", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({
      userInput: "secret prompt",
      reasoningText: "secret reasoning",
      outputText: "secret response",
      toolCalls: [{ name: "execute_command", args: { command: "ls" }, output: "huge output", status: "error" }],
    }));
    const light = store.listUsageLight();
    expect(light).toHaveLength(1);
    const rec = light[0] as unknown as Record<string, unknown>;
    expect(rec.userInput).toBeUndefined();
    expect(rec.reasoningText).toBeUndefined();
    expect(rec.outputText).toBeUndefined();
    expect(rec.inputTokens).toBe(100);
    // Light keeps the name and status (drives the dashboard dot) but strips args/output.
    expect(light[0].toolCalls).toEqual([{ name: "execute_command", status: "error" }]);
  });

  it("getSessionDetail returns a session's turns oldest-first (execution order)", async () => {
    const store = await freshStore();
    // Two turns in one session, appended in execution order (read then edit).
    store.appendUsage(baseTurn({ toolCalls: [{ name: "file_read", args: {}, output: "r", status: "ok" }] }));
    store.appendUsage(baseTurn({ toolCalls: [{ name: "file_edit", args: {}, output: "e", status: "ok" }] }));
    const detail = store.getSessionDetail("s1");
    expect(detail.flatMap((t) => t.toolCalls.map((tc) => tc.name))).toEqual(["file_read", "file_edit"]);
  });

  it("keeps only the light projection in memory (heavy content stays on disk)", async () => {
    const store = await freshStore();
    store.appendUsage(baseTurn({ reasoningText: "secret", outputText: "secret", userInput: "secret" }));
    // listUsageLight is memory-backed; it must not carry heavy fields…
    const light = store.listUsageLight()[0] as unknown as Record<string, unknown>;
    expect(light.reasoningText).toBeUndefined();
    expect(light.outputText).toBeUndefined();
    // …but getSessionDetail (disk-backed) still has them.
    expect(store.getSessionDetail("s1")[0].reasoningText).toBe("secret");
  });

  it("toLight defaults a missing tool status to ok (tolerates pre-status records)", async () => {
    const store = await freshStore();
    // Simulate a record written before status existed — no status on the tool call.
    store.appendUsage(baseTurn({
      toolCalls: [{ name: "file_read", args: {}, output: "x" } as unknown as { name: string; args: Record<string, unknown>; output: string; status: "ok" }],
    }));
    expect(store.listUsageLight()[0].toolCalls).toEqual([{ name: "file_read", status: "ok" }]);
  });

  it("loads existing JSONL into the in-memory log on init (newest first)", async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
    process.env.WORKSPACES_ROOT = ROOT;
    // Seed the file oldest-first; the store should expose it newest-first.
    fs.writeFileSync(FILE, [
      JSON.stringify({ id: "1", timestamp: "2026-01-01T00:00:00Z", ...baseTurn() }),
      JSON.stringify({ id: "2", timestamp: "2026-01-02T00:00:00Z", ...baseTurn() }),
    ].join("\n") + "\n");
    clearGlobalLog();
    vi.resetModules();
    const store = await import("./usageStore");
    const all = store.listUsage();
    expect(all.map((r) => r.id)).toEqual(["2", "1"]);
  });
});

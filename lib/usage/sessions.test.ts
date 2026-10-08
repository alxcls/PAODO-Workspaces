import { describe, it, expect } from "vitest";
import type { LightTurnRecord } from "./types";
import { groupBySessions } from "./sessions";

function rec(over: Partial<LightTurnRecord> = {}): LightTurnRecord {
  return {
    id: "r1",
    sessionId: "s1",
    workspaceId: "w1",
    workspaceName: "Alpha",
    status: "success",
    timestamp: "2026-01-01T00:00:00.000Z",
    inputTokensTotal: 0,
    inputTokensCacheRead: 0,
    inputTokensCacheWrite: 0,
    outputTokensTotal: 0,
    outputTokensReasoning: 0,
    toolCalls: [],
    ...over,
  };
}

describe("groupBySessions", () => {
  it("folds every turn of a run into one row, summing token + tool totals", () => {
    const sessions = groupBySessions([
      rec({
        id: "a",
        inputTokensTotal: 100,
        inputTokensCacheRead: 5,
        outputTokensTotal: 10,
        toolCalls: [{ name: "glob", status: "ok" }],
      }),
      rec({
        id: "b",
        inputTokensTotal: 50,
        inputTokensCacheRead: 5,
        outputTokensTotal: 20,
        toolCalls: [
          { name: "exec", status: "error" },
          { name: "read", status: "ok" },
        ],
      }),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "s1",
      inputTokensTotal: 150,
      inputTokensCacheRead: 10,
      outputTokensTotal: 30,
      toolTotal: 3,
    });
  });

  it("collects distinct models in first-seen order", () => {
    const [s] = groupBySessions([
      rec({ id: "a", model: "gpt-x" }),
      rec({ id: "b", model: "claude-y" }),
      rec({ id: "c", model: "gpt-x" }),
    ]);
    expect(s.models).toEqual(["gpt-x", "claude-y"]);
  });

  it("defaults a missing origin to 'manual'", () => {
    const [s] = groupBySessions([rec({ origin: undefined })]);
    expect(s.origin).toBe("manual");
  });

  it("uses the earliest turn timestamp as the session start", () => {
    const [s] = groupBySessions([
      rec({ id: "a", timestamp: "2026-01-01T00:05:00.000Z" }),
      rec({ id: "b", timestamp: "2026-01-01T00:01:00.000Z" }),
    ]);
    expect(s.timestamp).toBe("2026-01-01T00:01:00.000Z");
  });

  it("orders sessions newest-started first", () => {
    const sessions = groupBySessions([
      rec({ sessionId: "old", timestamp: "2026-01-01T00:00:00.000Z" }),
      rec({ sessionId: "new", timestamp: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });

  it("does not re-price a historical turn whose stored cost is absent", () => {
    const [s] = groupBySessions([rec({ model: "chatgpt-4o-latest" })]);
    expect(s.cost).toBeUndefined();
  });

  it("uses the cost frozen by the usage store", () => {
    const [s] = groupBySessions([rec({ model: "not-a-real-model", cost: 0.123 })]);
    expect(s.cost).toBe(0.123);
  });

  it("totals a single-currency run in that currency", () => {
    const [s] = groupBySessions([
      rec({ id: "a", model: "qwen3.6-35b-a3b", cost: 0.2, costCurrency: "EUR" }),
      rec({ id: "b", model: "qwen3.6-35b-a3b", cost: 0.1, costCurrency: "EUR" }),
    ]);
    expect(s.cost).toBeCloseTo(0.3);
    expect(s.costByCurrency).toEqual({ EUR: 0.30000000000000004 });
  });

  // The failure this prevents: €0.20 + $0.10 rendered as "0.30" of nothing in particular.
  it("keeps a mixed-currency run as separate subtotals rather than one meaningless sum", () => {
    const [s] = groupBySessions([
      rec({ id: "a", model: "qwen3.6-35b-a3b", cost: 0.2, costCurrency: "EUR" }),
      rec({ id: "b", model: "gpt-5.1", cost: 0.1, costCurrency: "USD" }),
    ]);
    expect(s.cost).toBeUndefined();
    expect(s.costByCurrency).toEqual({ EUR: 0.2, USD: 0.1 });
  });

  // A turn recorded before the currency column existed was billed in dollars, not in "unknown".
  it("reads a stored cost with no currency as dollars", () => {
    const [s] = groupBySessions([rec({ model: "gpt-5.1", cost: 0.5 })]);
    expect(s.costByCurrency).toEqual({ USD: 0.5 });
  });

  it("leaves a run that recorded no error unmarked, failed tool calls included", () => {
    const [s] = groupBySessions([rec({ toolCalls: [{ name: "exec", status: "error" }] })]);
    expect(s.error).toBeUndefined();
  });

  it("keeps the last error of the run — the one it stopped on", () => {
    const [s] = groupBySessions([
      rec({ id: "b", timestamp: "2026-01-01T00:02:00.000Z", error: { message: "gave up" } }),
      rec({ id: "a", timestamp: "2026-01-01T00:01:00.000Z", error: { code: "RETRY", message: "first failure" } }),
    ]);
    expect(s.error).toEqual({ message: "gave up" });
  });

  it("prefers the terminal error when it shares a millisecond with the turn error it followed", () => {
    // recordRunError appends its own row, so both can carry the same timestamp; the newest-first
    // list decides which of the two is terminal.
    const [s] = groupBySessions([
      rec({ id: "terminal", error: { code: "TIMEOUT", message: "run aborted" } }),
      rec({ id: "turn", error: { message: "tool blew up" } }),
    ]);
    expect(s.error).toEqual({ code: "TIMEOUT", message: "run aborted" });
  });

  it("marks the conversation live when any of the run's turns still resolves it", () => {
    const [s] = groupBySessions([rec({ id: "a", conversationId: "c1", conversationLive: true })]);
    expect(s.conversationLive).toBe(true);
  });

  it("keeps the id of a conversation that is gone, but not as something to open", () => {
    const [deleted] = groupBySessions([rec({ conversationId: "c1", conversationLive: false })]);
    expect(deleted).toMatchObject({ conversationId: "c1", conversationLive: false });
    // Records from a reader that never set the flag must not be linked on a guess either.
    const [unknown] = groupBySessions([rec({ conversationId: "c1" })]);
    expect(unknown.conversationLive).toBe(false);
  });
});

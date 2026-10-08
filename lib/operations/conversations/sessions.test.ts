import { describe, expect, it, vi } from "vitest";
import type { LightTurnRecord, SessionTextRecord } from "@/lib/usage/types";
import { ConversationNotFoundError, SessionNotFoundError } from "@/lib/operations/agent/errors";
import {
  getConversationSession,
  listConversationSessions,
  SESSION_TEXT_MAX_CHARS,
  type ConversationSessionsDeps,
} from "./sessions";

function turn(over: Partial<LightTurnRecord> = {}): LightTurnRecord {
  return {
    id: "t1",
    sessionId: "s1",
    conversationId: "conv-1",
    conversationLive: true,
    workspaceId: "ws-1",
    workspaceName: "TEST_WS6",
    origin: "chat",
    status: "success",
    timestamp: "2026-10-03T10:01:00.000Z",
    model: "deepseek-flash",
    inputTokensTotal: 0,
    inputTokensCacheRead: 0,
    inputTokensCacheWrite: 0,
    outputTokensTotal: 0,
    outputTokensReasoning: 0,
    toolCalls: [],
    ...over,
  };
}

function fixture(
  records: LightTurnRecord[],
  { workspace = true, conversation = true, texts = [] as SessionTextRecord[] } = {},
) {
  return {
    workspaces: { getWorkspace: vi.fn(() => (workspace ? ({ id: "ws-1" } as never) : undefined)) },
    conversations: { getMeta: vi.fn(() => (conversation ? ({ id: "conv-1" } as never) : undefined)) },
    usage: vi.fn(() => records),
    texts: vi.fn(() => texts),
  } satisfies ConversationSessionsDeps;
}

describe("listConversationSessions", () => {
  it("folds a run's turns into the dashboard row, without the workspace and conversation", () => {
    const deps = fixture([
      turn({ id: "a", inputTokensTotal: 20_000, inputTokensCacheRead: 19_000, outputTokensTotal: 300, cost: 0.0007 }),
      turn({
        id: "b",
        inputTokensTotal: 6_400,
        inputTokensCacheRead: 6_300,
        outputTokensTotal: 265,
        cost: 0.0005,
        toolCalls: [{ name: "read", status: "ok" }],
      }),
    ]);

    const result = listConversationSessions("ws-1", "conv-1", deps);

    expect(deps.usage).toHaveBeenCalledWith("ws-1", "conv-1", undefined);
    expect(result).toEqual({
      sessions: [
        {
          sessionId: "s1",
          status: "success",
          origin: "chat",
          models: ["deepseek-flash"],
          startedAt: "2026-10-03T10:01:00.000Z",
          inputTokensUncached: 1_100,
          inputTokensCacheRead: 25_300,
          outputTokensTotal: 565,
          toolExec: 1,
          costByCurrency: { USD: expect.closeTo(0.0012) },
        },
      ],
    });
  });

  it("states the run's stored outcome beside the error it stopped on", () => {
    const deps = fixture([turn({ status: "timeout", error: { code: "TIMEOUT", message: "run aborted" } })]);
    expect(listConversationSessions("ws-1", "conv-1", deps)?.sessions[0]).toMatchObject({
      status: "timeout",
      error: { code: "TIMEOUT", message: "run aborted" },
    });
  });

  it("counts the characters of each run's message and answer, leaving out the ones it does not have", () => {
    const deps = fixture([turn({ sessionId: "s1" }), turn({ id: "t2", sessionId: "s2" })], {
      texts: [
        { sessionId: "s1", userInput: "fix it\nplease", agentResponse: "Done 🙂" },
        { sessionId: "s2", userInput: "and this" },
      ],
    });
    const [first, second] = listConversationSessions("ws-1", "conv-1", deps)?.sessions ?? [];
    expect(first).toMatchObject({ sessionId: "s1", userInputChars: 13, agentResponseChars: 6 });
    expect(second).toMatchObject({ sessionId: "s2", userInputChars: 8 });
    expect(second).not.toHaveProperty("agentResponseChars");
  });

  it("returns null for an unknown workspace without reading usage", () => {
    const deps = fixture([], { workspace: false });
    expect(listConversationSessions("ws-1", "conv-1", deps)).toBeNull();
    expect(deps.usage).not.toHaveBeenCalled();
  });

  it("refuses an unknown conversation rather than answering with no runs", () => {
    const deps = fixture([], { conversation: false });
    expect(() => listConversationSessions("ws-1", "conv-1", deps)).toThrow(ConversationNotFoundError);
    expect(deps.usage).not.toHaveBeenCalled();
  });
});

describe("getConversationSession", () => {
  it("gives the run's list row plus its message and answer, read for that session only", () => {
    const deps = fixture([turn({ outputTokensTotal: 40 })], {
      texts: [{ sessionId: "s1", userInput: "fix it", agentResponse: "Done." }],
    });

    const result = getConversationSession("ws-1", "conv-1", "s1", deps);

    expect(deps.usage).toHaveBeenCalledWith("ws-1", "conv-1", "s1");
    expect(deps.texts).toHaveBeenCalledWith("ws-1", "conv-1", "s1");
    expect(result?.session).toEqual({
      ...listConversationSessions("ws-1", "conv-1", deps)?.sessions[0],
      userInput: "fix it",
      agentResponse: "Done.",
    });
    expect(result?.session).toMatchObject({ userInputChars: 6, agentResponseChars: 5 });
  });

  it("cuts a long answer and says how many characters were left out", () => {
    const long = "a".repeat(SESSION_TEXT_MAX_CHARS + 1);
    const deps = fixture([turn()], { texts: [{ sessionId: "s1", userInput: "short", agentResponse: long }] });
    const session = getConversationSession("ws-1", "conv-1", "s1", deps)?.session;
    expect(session?.agentResponse).toHaveLength(SESSION_TEXT_MAX_CHARS);
    expect(session?.agentResponseOmittedChars).toBe(1);
    expect(session).not.toHaveProperty("userInputOmittedChars");
  });

  it("counts characters, not UTF-16 units, so an emoji at the edge is never split", () => {
    const text = `${"a".repeat(SESSION_TEXT_MAX_CHARS - 1)}🙂🙂`;
    const deps = fixture([turn()], { texts: [{ sessionId: "s1", userInput: text }] });
    const session = getConversationSession("ws-1", "conv-1", "s1", deps)?.session;
    expect(session?.userInput).toBe(`${"a".repeat(SESSION_TEXT_MAX_CHARS - 1)}🙂`);
    expect(session?.userInputOmittedChars).toBe(1);
  });

  it("keeps a text that fills the limit exactly", () => {
    const text = "🙂".repeat(SESSION_TEXT_MAX_CHARS);
    const deps = fixture([turn()], { texts: [{ sessionId: "s1", agentResponse: text }] });
    const session = getConversationSession("ws-1", "conv-1", "s1", deps)?.session;
    expect(session?.agentResponse).toBe(text);
    expect(session).not.toHaveProperty("agentResponseOmittedChars");
  });

  it("leaves the answer out of a run that has none", () => {
    const deps = fixture([turn({ status: "failed" })], { texts: [{ sessionId: "s1", userInput: "fix it" }] });
    const session = getConversationSession("ws-1", "conv-1", "s1", deps)?.session;
    expect(session).toMatchObject({ status: "failed", userInput: "fix it" });
    expect(session).not.toHaveProperty("agentResponse");
    expect(session).not.toHaveProperty("agentResponseChars");
  });

  it("refuses a session the conversation does not have", () => {
    expect(() => getConversationSession("ws-1", "conv-1", "s1", fixture([]))).toThrow(SessionNotFoundError);
  });

  it("returns null for an unknown workspace and refuses an unknown conversation, without reading usage", () => {
    const noWorkspace = fixture([turn()], { workspace: false });
    expect(getConversationSession("ws-1", "conv-1", "s1", noWorkspace)).toBeNull();
    const noConversation = fixture([turn()], { conversation: false });
    expect(() => getConversationSession("ws-1", "conv-1", "s1", noConversation)).toThrow(ConversationNotFoundError);
    expect(noWorkspace.usage).not.toHaveBeenCalled();
    expect(noConversation.usage).not.toHaveBeenCalled();
  });
});

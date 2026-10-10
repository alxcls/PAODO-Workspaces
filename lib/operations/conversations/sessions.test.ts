import { describe, expect, it, vi } from "vitest";
import type { LightTurnRecord, SessionTextRecord } from "@/lib/usage/types";
import { ConversationNotFoundError, SessionNotFoundError } from "@/lib/operations/agent/errors";
import {
  getConversationSession,
  listConversationSessions,
  SESSION_PREVIEW_MAX_CHARS,
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
  it("gives each run only what identifies it, the start of its texts and their full sizes", () => {
    const deps = fixture(
      [turn({ id: "a", cost: 0.0007 }), turn({ id: "b", toolCalls: [{ name: "read", status: "ok" }] })],
      {
        texts: [{ sessionId: "s1", userInput: "fix it\nplease", agentResponse: "Done 🙂" }],
      },
    );

    const result = listConversationSessions("ws-1", "conv-1", deps);

    expect(deps.usage).toHaveBeenCalledWith("ws-1", "conv-1", undefined);
    expect(result).toEqual({
      sessions: [
        {
          sessionId: "s1",
          startedAt: "2026-10-03T10:01:00.000Z",
          status: "success",
          userInput: "fix it\nplease",
          agentResponse: "Done 🙂",
          userInputChars: 13,
          agentResponseChars: 6,
        },
      ],
    });
  });

  it("cuts each text at the preview length and still counts the whole of it", () => {
    const long = `${"a".repeat(SESSION_PREVIEW_MAX_CHARS - 1)}🙂🙂 and more`;
    const deps = fixture([turn()], { texts: [{ sessionId: "s1", userInput: long, agentResponse: "short" }] });
    const [session] = listConversationSessions("ws-1", "conv-1", deps)?.sessions ?? [];
    expect(session.userInput).toBe(`${"a".repeat(SESSION_PREVIEW_MAX_CHARS - 1)}🙂`);
    expect(session.userInputChars).toBe(SESSION_PREVIEW_MAX_CHARS + 10);
    expect(session.agentResponse).toBe("short");
  });

  it("keeps a text that fills the preview exactly", () => {
    const text = "🙂".repeat(SESSION_PREVIEW_MAX_CHARS);
    const deps = fixture([turn()], { texts: [{ sessionId: "s1", agentResponse: text }] });
    expect(listConversationSessions("ws-1", "conv-1", deps)?.sessions[0].agentResponse).toBe(text);
  });

  it("leaves out the texts and sizes a run does not have", () => {
    const deps = fixture([turn({ status: "failed" })], { texts: [{ sessionId: "s1", userInput: "and this" }] });
    const [session] = listConversationSessions("ws-1", "conv-1", deps)?.sessions ?? [];
    expect(session).toMatchObject({ status: "failed", userInput: "and this", userInputChars: 8 });
    expect(session).not.toHaveProperty("agentResponse");
    expect(session).not.toHaveProperty("agentResponseChars");
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
  it("folds the run's turns into its cost and gives both texts, read for that session only", () => {
    const deps = fixture(
      [
        turn({ id: "a", inputTokensTotal: 20_000, inputTokensCacheRead: 19_000, outputTokensTotal: 300, cost: 0.0007 }),
        turn({
          id: "b",
          inputTokensTotal: 6_400,
          inputTokensCacheRead: 6_300,
          outputTokensTotal: 265,
          cost: 0.0005,
          toolCalls: [{ name: "read", status: "ok" }],
        }),
      ],
      { texts: [{ sessionId: "s1", userInput: "fix it", agentResponse: "Done." }] },
    );

    const result = getConversationSession("ws-1", "conv-1", "s1", deps);

    expect(deps.usage).toHaveBeenCalledWith("ws-1", "conv-1", "s1");
    expect(deps.texts).toHaveBeenCalledWith("ws-1", "conv-1", "s1");
    expect(result).toEqual({
      session: {
        sessionId: "s1",
        startedAt: "2026-10-03T10:01:00.000Z",
        status: "success",
        origin: "chat",
        models: ["deepseek-flash"],
        inputTokensUncached: 1_100,
        inputTokensCacheRead: 25_300,
        outputTokensTotal: 565,
        callCount: 1,
        costByCurrency: { USD: expect.closeTo(0.0012) },
        userInput: "fix it",
        agentResponse: "Done.",
      },
    });
  });

  it("returns a long text whole, with no cut and no size of its own", () => {
    const long = "🙂".repeat(50_000);
    const deps = fixture([turn()], { texts: [{ sessionId: "s1", userInput: "short", agentResponse: long }] });
    const session = getConversationSession("ws-1", "conv-1", "s1", deps)?.session;
    expect(session?.agentResponse).toBe(long);
    expect(session).not.toHaveProperty("agentResponseChars");
    expect(session).not.toHaveProperty("agentResponseOmittedChars");
  });

  it("states the run's stored outcome beside the error it stopped on, and no answer", () => {
    const deps = fixture([turn({ status: "timeout", error: { code: "TIMEOUT", message: "run aborted" } })], {
      texts: [{ sessionId: "s1", userInput: "fix it" }],
    });
    const session = getConversationSession("ws-1", "conv-1", "s1", deps)?.session;
    expect(session).toMatchObject({
      status: "timeout",
      error: { code: "TIMEOUT", message: "run aborted" },
      userInput: "fix it",
    });
    expect(session).not.toHaveProperty("agentResponse");
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

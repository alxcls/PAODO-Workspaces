import { describe, expect, it, vi } from "vitest";
import type { SessionToolCallRecord } from "@/lib/usage/types";
import { CallNotFoundError, ConversationNotFoundError, SessionNotFoundError } from "@/lib/operations/agent/errors";
import { getConversationSessionCall, listConversationSessionCalls, type SessionCallsDeps } from "./calls";

function call(over: Partial<SessionToolCallRecord> = {}): SessionToolCallRecord {
  return {
    id: "k1",
    timestamp: "2026-10-03T10:01:00.000Z",
    name: "file_read",
    args: { path: "a.ts" },
    output: "line1\nline2",
    status: "ok",
    ...over,
  };
}

function fixture(records: SessionToolCallRecord[] | undefined, { workspace = true, conversation = true } = {}) {
  return {
    workspaces: { getWorkspace: vi.fn(() => (workspace ? ({ id: "ws-1" } as never) : undefined)) },
    conversations: { getMeta: vi.fn(() => (conversation ? ({ id: "conv-1" } as never) : undefined)) },
    calls: vi.fn(() => records),
  } satisfies SessionCallsDeps;
}

describe("listConversationSessionCalls", () => {
  it("lists each call with the size of its texts and neither text", () => {
    const deps = fixture([call(), call({ id: "k2", name: "exec_command", args: {}, output: "", status: "error" })]);

    const result = listConversationSessionCalls("ws-1", "conv-1", "s1", deps);

    expect(deps.calls).toHaveBeenCalledWith("ws-1", "conv-1", "s1");
    expect(result).toEqual({
      calls: [
        {
          callId: "k1",
          timestamp: "2026-10-03T10:01:00.000Z",
          tool: "file_read",
          status: "ok",
          inputChars: 15,
          outputChars: 11,
        },
        {
          callId: "k2",
          timestamp: "2026-10-03T10:01:00.000Z",
          tool: "exec_command",
          status: "error",
          inputChars: 2,
          outputChars: 0,
        },
      ],
    });
  });

  it("counts whole characters, so an emoji is one", () => {
    const deps = fixture([call({ output: "ok 👍" })]);
    expect(listConversationSessionCalls("ws-1", "conv-1", "s1", deps)?.calls[0].outputChars).toBe(4);
  });

  it("gives an empty list for a session that called no tool", () => {
    expect(listConversationSessionCalls("ws-1", "conv-1", "s1", fixture([]))).toEqual({ calls: [] });
  });

  it("returns null for an unknown workspace without reading anything", () => {
    const deps = fixture([call()], { workspace: false });
    expect(listConversationSessionCalls("ws-1", "conv-1", "s1", deps)).toBeNull();
    expect(deps.calls).not.toHaveBeenCalled();
  });

  it("refuses a conversation the workspace does not have", () => {
    const deps = fixture([call()], { conversation: false });
    expect(() => listConversationSessionCalls("ws-1", "conv-1", "s1", deps)).toThrow(ConversationNotFoundError);
    expect(deps.calls).not.toHaveBeenCalled();
  });

  it("refuses a session the conversation does not have", () => {
    expect(() => listConversationSessionCalls("ws-1", "conv-1", "s1", fixture(undefined))).toThrow(
      SessionNotFoundError,
    );
  });
});

describe("getConversationSessionCall", () => {
  it("gives the call with both texts in full, at the sizes the list announced, and no sizes of its own", () => {
    const output = "x".repeat(50_000);
    const deps = fixture([call(), call({ id: "k2", args: { command: "npm test" }, output })]);

    const result = getConversationSessionCall("ws-1", "conv-1", "s1", "k2", deps);
    const [, row] = listConversationSessionCalls("ws-1", "conv-1", "s1", deps)!.calls;

    expect(result).toEqual({
      call: {
        callId: "k2",
        timestamp: "2026-10-03T10:01:00.000Z",
        tool: "file_read",
        status: "ok",
        input: { command: "npm test" },
        output,
      },
    });
    expect(JSON.stringify(result!.call.input)).toHaveLength(row.inputChars);
    expect(result!.call.output).toHaveLength(row.outputChars);
  });

  it("refuses a call the session does not have", () => {
    expect(() => getConversationSessionCall("ws-1", "conv-1", "s1", "nope", fixture([call()]))).toThrow(
      CallNotFoundError,
    );
  });

  it("returns null for an unknown workspace", () => {
    const deps = fixture([call()], { workspace: false });
    expect(getConversationSessionCall("ws-1", "conv-1", "s1", "k1", deps)).toBeNull();
  });
});

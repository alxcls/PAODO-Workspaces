import { describe, expect, it, vi } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import {
  createWorkspaceConversation,
  getWorkspaceConversation,
  listWorkspaceConversations,
  prepareWorkspaceChat,
  stopWorkspaceConversation,
  type ConversationOperationDeps,
} from "./manage";

const meta = { id: "conv-1", title: "First", createdAt: "now", updatedAt: "now", lastMessageAt: "now" };

function fixture(running = false): ConversationOperationDeps {
  const live = [{ source: "live" }] as unknown as BaseMessage[];
  const persisted = [{ source: "persisted" }] as unknown as BaseMessage[];
  return {
    workspaces: { getWorkspace: vi.fn(() => ({ id: "ws-1" }) as never) },
    conversations: {
      listConversations: vi.fn(() => [meta]),
      createConversation: vi.fn(() => meta),
      getMeta: vi.fn(() => meta),
      getMessages: vi.fn(() => live),
      getPersistedMessages: vi.fn(() => persisted),
      getActiveId: vi.fn(() => meta.id),
      setActiveId: vi.fn(),
    },
    broker: {
      runningConversationIds: vi.fn(() => (running ? [meta.id] : [])),
      isRunning: vi.fn(() => running),
      peekUserInput: vi.fn(() => (running ? "in flight" : null)),
      stop: vi.fn(() => running),
    },
    transcript: vi.fn((messages) => [
      { role: "assistant" as const, content: (messages[0] as never as { source: string }).source },
    ]),
    outputTokens: vi.fn(() => new Map()),
    startRun: vi.fn(() => ({ workspaceId: "ws-1", conversationId: meta.id, origin: "chat" as const, started: true })),
  };
}

describe("conversation operations", () => {
  it("projects persisted history and user input while a conversation is running", () => {
    const result = listWorkspaceConversations("ws-1", { includeActive: true }, fixture(true));
    expect(result?.conversations[0].running).toBe(true);
    expect(result?.active).toMatchObject({
      id: "conv-1",
      running: true,
      userInput: "in flight",
      transcript: [{ role: "assistant", content: "persisted" }],
    });
  });

  it("uses live history when idle and refuses an unknown conversation", () => {
    expect(getWorkspaceConversation("ws-1", "conv-1", fixture(false))).toMatchObject({
      running: false,
      userInput: null,
      transcript: [{ role: "assistant", content: "live" }],
    });
    const deps = fixture();
    vi.mocked(deps.conversations!.getMeta).mockReturnValue(undefined);
    expect(() => getWorkspaceConversation("ws-1", "missing", deps)).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("creates and stops through canonical receipts", () => {
    const deps = fixture(true);
    expect(createWorkspaceConversation("ws-1", deps)).toEqual({
      workspaceId: "ws-1",
      conversation: { ...meta, running: false },
    });
    expect(stopWorkspaceConversation("ws-1", "conv-1", deps)).toEqual({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      stopped: true,
    });
  });

  it("resolves, starts and activates chat in one operation", () => {
    const deps = fixture();
    expect(prepareWorkspaceChat("ws-1", { message: "  hello  " }, deps)).toEqual({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      started: true,
    });
    expect(deps.startRun).toHaveBeenCalledWith("ws-1", {
      prompt: "hello",
      origin: "chat",
      conversation: { mode: "existing", id: "conv-1" },
    });
    expect(deps.conversations!.setActiveId).toHaveBeenCalledWith("ws-1", "conv-1");
  });

  it("attaches without starting and reports a missing workspace as null", () => {
    const deps = fixture();
    expect(prepareWorkspaceChat("ws-1", {}, deps)).toEqual({
      workspaceId: "ws-1",
      conversationId: "conv-1",
      started: null,
    });
    expect(deps.startRun).not.toHaveBeenCalled();
    vi.mocked(deps.workspaces!.getWorkspace).mockReturnValue(undefined);
    expect(listWorkspaceConversations("missing", {}, deps)).toBeNull();
  });
});

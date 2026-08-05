import type { BaseMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "@/lib/workspace/types";
import type { StartRunParams } from "@/lib/agent/runBroker";
import { ConversationNotFoundError, RunInputInvalidError } from "./errors";
import { startWorkspaceRun, type StartWorkspaceRunDeps } from "./run";

const WORKSPACE: Workspace = {
  id: "ws-1",
  name: "Workspace One",
  dir: "/workspaces/ws-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  maxIterations: 17,
  maxRunMinutes: 23,
  internetAccess: true,
};

function harness(options: { workspace?: Workspace; messages?: BaseMessage[] | null; alreadyRunning?: boolean } = {}) {
  const calls: string[] = [];
  const messages = options.messages === undefined ? ([] as BaseMessage[]) : options.messages;
  const createConversation = vi.fn((_workspaceId: string, opts?: { kind?: "user" | "skill-call" | "scheduled" }) => {
    calls.push("createConversation");
    return {
      id: "conv-created",
      title: "conv-cre",
      ...(opts?.kind ? { kind: opts.kind } : {}),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
    };
  });
  const getMessages = vi.fn(() => {
    calls.push("getMessages");
    return messages;
  });
  const refreshPrompt = vi.fn((_ws: Pick<Workspace, "id" | "name" | "dir">, live: BaseMessage[]) => {
    calls.push("refreshPrompt");
    live.push({ refreshed: true } as unknown as BaseMessage);
  });
  const startRun = vi.fn((_params: StartRunParams) => {
    calls.push("startRun");
    return { alreadyRunning: options.alreadyRunning ?? false };
  });
  const getWorkspace = vi.fn(() => options.workspace);

  const deps: StartWorkspaceRunDeps = {
    workspaces: { getWorkspace },
    conversations: { createConversation, getMessages },
    broker: { startRun },
    refreshPrompt,
  };
  return { calls, messages, createConversation, getMessages, refreshPrompt, startRun, getWorkspace, deps };
}

describe("startWorkspaceRun", () => {
  it("returns null for an unknown workspace without creating a conversation or run", () => {
    const h = harness();

    expect(
      startWorkspaceRun("missing", { prompt: "go", origin: "api", conversation: { mode: "create" } }, h.deps),
    ).toBeNull();
    expect(h.createConversation).not.toHaveBeenCalled();
    expect(h.getMessages).not.toHaveBeenCalled();
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it("forwards the workspace identity and run limits to the broker", () => {
    const h = harness({ workspace: WORKSPACE });

    startWorkspaceRun(
      WORKSPACE.id,
      { prompt: "  do the work  ", origin: "chat", conversation: { mode: "existing", id: "conv-existing" } },
      h.deps,
    );

    expect(h.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE.id,
        workspaceName: WORKSPACE.name,
        workspaceDir: WORKSPACE.dir,
        conversationId: "conv-existing",
        userInput: "do the work",
        maxIterations: 17,
        maxRunMinutes: 23,
        origin: "chat",
      }),
    );
  });

  it("creates a conversation and forwards its requested kind", () => {
    const h = harness({ workspace: WORKSPACE });

    const receipt = startWorkspaceRun(
      WORKSPACE.id,
      { prompt: "go", origin: "scheduled", conversation: { mode: "create", kind: "scheduled" } },
      h.deps,
    );

    expect(h.createConversation).toHaveBeenCalledWith(WORKSPACE.id, { kind: "scheduled" });
    expect(h.getMessages).toHaveBeenCalledWith(WORKSPACE.id, "conv-created");
    expect(receipt?.conversationId).toBe("conv-created");
  });

  it("uses an existing conversation without creating one", () => {
    const h = harness({ workspace: WORKSPACE });

    startWorkspaceRun(
      WORKSPACE.id,
      { prompt: "go", origin: "api", conversation: { mode: "existing", id: "conv-existing" } },
      h.deps,
    );

    expect(h.createConversation).not.toHaveBeenCalled();
    expect(h.getMessages).toHaveBeenCalledWith(WORKSPACE.id, "conv-existing");
    expect(h.startRun).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-existing" }));
  });

  it("throws when an existing conversation is gone and does not start a run", () => {
    const h = harness({ workspace: WORKSPACE, messages: null });

    expect(() =>
      startWorkspaceRun(
        WORKSPACE.id,
        { prompt: "go", origin: "api", conversation: { mode: "existing", id: "gone" } },
        h.deps,
      ),
    ).toThrow(ConversationNotFoundError);
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it("rejects a blank prompt before creating a conversation", () => {
    const h = harness({ workspace: WORKSPACE });

    expect(() =>
      startWorkspaceRun(WORKSPACE.id, { prompt: " \n\t ", origin: "api", conversation: { mode: "create" } }, h.deps),
    ).toThrow(RunInputInvalidError);
    expect(h.getWorkspace).not.toHaveBeenCalled();
    expect(h.createConversation).not.toHaveBeenCalled();
  });

  it("refreshes the prompt before startRun on the same live messages array", () => {
    const live: BaseMessage[] = [];
    const h = harness({ workspace: WORKSPACE, messages: live });

    startWorkspaceRun(
      WORKSPACE.id,
      { prompt: "go", origin: "chat", conversation: { mode: "existing", id: "conv-existing" } },
      h.deps,
    );

    expect(h.calls).toEqual(["getMessages", "refreshPrompt", "startRun"]);
    expect(h.refreshPrompt.mock.calls[0][1]).toBe(live);
    expect(h.startRun.mock.calls[0][0].messages).toBe(live);
    expect(h.startRun.mock.calls[0][0].messages).toContainEqual({ refreshed: true });
  });

  it("reports an already-running conversation without losing its id", () => {
    const h = harness({ workspace: WORKSPACE, alreadyRunning: true });

    expect(
      startWorkspaceRun(
        WORKSPACE.id,
        { prompt: "go", origin: "chat", conversation: { mode: "existing", id: "conv-existing" } },
        h.deps,
      ),
    ).toEqual({
      workspaceId: WORKSPACE.id,
      conversationId: "conv-existing",
      origin: "chat",
      started: false,
    });
  });

  it.each(["chat", "api", "scheduled"] as const)("passes the %s origin through verbatim", (origin) => {
    const h = harness({ workspace: WORKSPACE });

    const receipt = startWorkspaceRun(
      WORKSPACE.id,
      { prompt: "go", origin, conversation: { mode: "existing", id: `conv-${origin}` } },
      h.deps,
    );

    expect(h.startRun).toHaveBeenCalledWith(expect.objectContaining({ origin }));
    expect(receipt?.origin).toBe(origin);
  });
});

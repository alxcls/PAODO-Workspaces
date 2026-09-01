// The public agent SSE projection. These pin the curated wire protocol external clients depend on:
// streamed `token` deltas as the run produces them, plus the final aggregate `response` frame kept
// for non-streaming clients.
import { describe, it, expect, vi } from "vitest";
import type { AgentEvent } from "@/lib/agent/runner";

const replayEvents: AgentEvent[] = [];
vi.mock("@/lib/agent/runBroker", () => ({
  subscribe: () => ({
    replay: replayEvents,
    userInput: "hi",
    status: "done" as const,
    unsubscribe: vi.fn(),
  }),
}));

import { apiConversationStream } from "./workspaceRunStream";

function req(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

async function frames(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.replace(/^data: /, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith(":"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("apiConversationStream", () => {
  it("streams each token as its own frame and still emits the final aggregate response", async () => {
    replayEvents.length = 0;
    replayEvents.push(
      { type: "token", content: "Hel" },
      { type: "token", content: "lo" },
      { type: "done" },
    );

    const events = await frames(apiConversationStream(req() as never, "ws-a", "conv-1"));

    expect(events.filter((e) => e.type === "token")).toEqual([
      { type: "token", content: "Hel" },
      { type: "token", content: "lo" },
    ]);
    const response = events.find((e) => e.type === "response");
    expect(response).toMatchObject({ content: "Hello", conversationId: "conv-1" });
    expect(events.at(-1)).toMatchObject({ type: "done", conversationId: "conv-1" });
  });

  it("streams reasoning frames separately from answer tokens", async () => {
    replayEvents.length = 0;
    replayEvents.push(
      { type: "reasoning", content: "thinking..." },
      { type: "token", content: "answer" },
      { type: "done" },
    );

    const events = await frames(apiConversationStream(req() as never, "ws-a", "conv-r"));

    expect(events.find((e) => e.type === "reasoning")).toEqual({ type: "reasoning", content: "thinking..." });
    const response = events.find((e) => e.type === "response");
    expect(response).toMatchObject({ content: "answer" });
  });

  it("exposes tool calls with args and pairs each result by id", async () => {
    replayEvents.length = 0;
    replayEvents.push(
      { type: "tool_start", name: "read_file", id: "call_1", args: { path: "a.ts" } },
      { type: "tool_result", name: "read_file", id: "call_1", result: "file contents" },
      { type: "done" },
    );

    const events = await frames(apiConversationStream(req() as never, "ws-a", "conv-tool"));

    expect(events.find((e) => e.type === "tool_start")).toEqual({
      type: "tool_start",
      name: "read_file",
      id: "call_1",
      args: { path: "a.ts" },
    });
    expect(events.find((e) => e.type === "tool_result")).toEqual({
      type: "tool_result",
      name: "read_file",
      id: "call_1",
      result: "file contents",
    });
  });

  it("suppresses the aggregate response when the run fails", async () => {
    replayEvents.length = 0;
    replayEvents.push(
      { type: "token", content: "partial" },
      { type: "error", message: "boom", code: "TIMEOUT" },
      { type: "done" },
    );

    const events = await frames(apiConversationStream(req() as never, "ws-a", "conv-2"));

    expect(events.some((e) => e.type === "response")).toBe(false);
    expect(events.find((e) => e.type === "error")).toMatchObject({ message: "boom", code: "TIMEOUT" });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "failed", code: "TIMEOUT" });
  });
});

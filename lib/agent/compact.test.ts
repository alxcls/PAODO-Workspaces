// Compaction must leave history valid for the next request: messages[0] stays the system message,
// every kept tool_call keeps its tool_result, and roles alternate after a summary is spliced in.

import { describe, it, expect } from "vitest";
import { SystemMessage, HumanMessage, AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { applyCompaction, stripToolOutputs, CLEARED, STRIPPABLE_TOOLS } from "./compact";
import { NO_USAGE } from "./modelGateway";

// A gateway stub returning a fixed brief, so summarize paths run without a network call. Shaped as
// a ModelGateway invocation because compaction now goes through the gateway like every other call.
const fakeModel = { invoke: async () => ({ message: new AIMessage("BRIEF"), usage: NO_USAGE }) } as never;

// Builds a realistic history: system, a user turn, then two work turns each = an AIMessage with
// one tool_call followed by its ToolMessage, then the compact_context turn (ai + ack).
function buildHistory(): BaseMessage[] {
  return [
    new SystemMessage("SYS"),
    new HumanMessage("do the job"),
    new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "file_read", args: {} }] }),
    new ToolMessage({ tool_call_id: "c1", content: "BIG FILE BODY" }),
    new AIMessage({ content: "", tool_calls: [{ id: "c2", name: "todo_write", args: {} }] }),
    new ToolMessage({ tool_call_id: "c2", content: "○ task" }),
    new AIMessage({ content: "", tool_calls: [{ id: "c3", name: "glob", args: {} }] }),
    new ToolMessage({ tool_call_id: "c3", content: "a.ts\nb.ts" }),
    new AIMessage({ content: "", tool_calls: [{ id: "c4", name: "compact_context", args: {} }] }),
    new ToolMessage({ tool_call_id: "c4", content: "[Context compacted: x.] Next step: y" }),
  ];
}

// Asserts no AIMessage tool_call is left without its matching ToolMessage later in the array.
function assertNoOrphans(messages: BaseMessage[]) {
  const resultIds = new Set(
    messages.filter((m) => m instanceof ToolMessage).map((m) => (m as ToolMessage).tool_call_id),
  );
  for (const m of messages) {
    if (m instanceof AIMessage && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) expect(resultIds.has(tc.id!)).toBe(true);
    }
  }
}

describe("compact — light (strip)", () => {
  // light wipes bulky re-derivable output (file_read, glob) but keeps todos and the compact ack.
  it("clears strippable tool output, preserves todos/compact ack and structure", async () => {
    const messages = buildHistory();
    const len = messages.length;
    await applyCompaction(fakeModel, messages, "light", "next");

    expect(messages.length).toBe(len); // no deletion
    expect((messages[3] as ToolMessage).content).toBe(CLEARED); // file_read stripped
    expect((messages[7] as ToolMessage).content).toBe(CLEARED); // glob stripped
    expect((messages[5] as ToolMessage).content).toBe("○ task"); // todo_write kept
    expect((messages[9] as ToolMessage).content).toContain("Next step"); // compact ack kept
    assertNoOrphans(messages);
  });

  // The strip list covers re-derivable tools but never the agent's stateful ones (todos/ack).
  it("STRIPPABLE_TOOLS excludes the agent's stateful tools", () => {
    expect(STRIPPABLE_TOOLS.has("todo_write")).toBe(false);
    expect(STRIPPABLE_TOOLS.has("compact_context")).toBe(false);
    expect(STRIPPABLE_TOOLS.has("file_read")).toBe(true);
  });
});

describe("compact — hard (wipe)", () => {
  // hard wipes everything to just [system, summary + next_step] — a clean slate.
  it("collapses to [system, Human(summary + next_step)]", async () => {
    const messages = buildHistory();
    await applyCompaction(fakeModel, messages, "hard", "map batch 020");

    expect(messages.length).toBe(2);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[1].content).toContain("BRIEF");
    expect(messages[1].content).toContain("Next step: map batch 020");
    assertNoOrphans(messages);
  });
});

describe("compact — medium (summary + verbatim tail)", () => {
  // medium summarizes the head, keeps a verbatim tail starting at an AIMessage (clean alternation).
  it("keeps [system, Human(summary), AIMessage, …] with no orphans", async () => {
    const messages = buildHistory();
    await applyCompaction(fakeModel, messages, "medium", "next");

    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(messages[1].content).toBe("BRIEF");
    // tail must start at an AIMessage so user→assistant alternation is clean
    expect(messages[2]).toBeInstanceOf(AIMessage);
    assertNoOrphans(messages);
  });
});

describe("stripToolOutputs is idempotent", () => {
  // Stripping twice is safe — already-cleared content is left untouched the second time.
  it("does not re-clear already-cleared content", () => {
    const messages = buildHistory();
    stripToolOutputs(messages);
    const first = (messages[3] as ToolMessage).content;
    stripToolOutputs(messages);
    expect((messages[3] as ToolMessage).content).toBe(first);
  });
});

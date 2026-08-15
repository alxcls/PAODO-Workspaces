// Mistral rejects any tool-call id that is not exactly 9 alphanumeric characters. What actually
// 400s is therefore not the id the current provider just minted — it is the ids already sitting in a
// replayed history, written by whichever provider the workspace used before. These tests pin the two
// properties that make a switch safe: every id comes out portable, and every tool_call still points
// at the ToolMessage that answered it.
import { describe, it, expect, vi } from "vitest";
import { AIMessage, ToolMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { normalizeToolCallIds, newToolCallId, isPortableToolCallId } from "./toolCallIds";
import { TOOL_CALL_ID_CONSTRAINT } from "./buildModel";
import { ALPHANUMERIC, satisfiesConstraint } from "./toolCallIdConstraint";

const PORTABLE = /^[A-Za-z0-9]{9}$/;

/** One assistant turn calling one tool, plus the result answering it. */
function pair(id: string, name = "file_read"): BaseMessage[] {
  return [
    new AIMessage({ content: "", tool_calls: [{ id, name, args: {} }] }),
    new ToolMessage({ tool_call_id: id, content: "result" }),
  ];
}

// The shape is derived from what providers declare, not written here — so it can change without
// anyone editing this module. These two tests are the tripwire: the first pins the shape that
// actually ships today, the second pins that everything else in the file follows the declaration
// rather than the literal regex above.
describe("the canonical id shape", () => {
  it("resolves to exactly 9 alphanumerics, as mistral demands", () => {
    expect(TOOL_CALL_ID_CONSTRAINT.alphabet).toBe(ALPHANUMERIC);
    expect(TOOL_CALL_ID_CONSTRAINT.minLength).toBe(9);
    expect(TOOL_CALL_ID_CONSTRAINT.maxLength).toBe(9);
  });

  it("agrees with the literal shape the rest of these tests assert", () => {
    for (let i = 0; i < 50; i++) {
      const id = newToolCallId();
      expect(satisfiesConstraint(id, TOOL_CALL_ID_CONSTRAINT)).toBe(true);
      expect(id).toMatch(PORTABLE);
    }
  });
});

describe("isPortableToolCallId", () => {
  it.each([
    ["exactly 9 alphanumerics", "abc123XYZ", true],
    ["8 characters", "abc123XY", false],
    ["10 characters", "abc123XYZ0", false],
    ["9 characters with an underscore", "abc_123XY", false],
    ["9 characters with a dash", "abc-123XY", false],
    ["empty", "", false],
  ])("treats %s as portable=%s", (_label, id, expected) => {
    expect(isPortableToolCallId(id)).toBe(expected);
  });
});

describe("normalizeToolCallIds", () => {
  // The real id shapes each provider mints. Anthropic's and OpenAI's are the ones that actually
  // reach Mistral after a mid-conversation provider switch.
  it.each([
    ["anthropic", "toolu_01A09q9rDJmwvLpPCJKtxpvB"],
    ["openai chat completions", "call_9dK2h1sQwErTyUiOpAs"],
    ["openai responses", "fc_68a1c2d3e4f5"],
    ["a provider that streamed none", "tc_0_1755212345678"],
    ["one carrying dashes", "0f1e2d3c-4b5a"],
  ])("rewrites a %s id on both halves of the pair", (_provider, id) => {
    const messages = pair(id);
    normalizeToolCallIds(messages);

    const call = (messages[0] as AIMessage).tool_calls![0];
    expect(call.id).toMatch(PORTABLE);
    // The pair must move together — a rewrite that touched only the AIMessage would orphan the
    // result, and the provider would reject the turn for an unanswered tool call.
    expect((messages[1] as ToolMessage).tool_call_id).toBe(call.id);
  });

  it("leaves an already-portable id untouched, so a mistral-only conversation is a no-op", () => {
    const messages = pair("abc123XYZ");
    normalizeToolCallIds(messages);
    expect((messages[0] as AIMessage).tool_calls![0].id).toBe("abc123XYZ");
    expect((messages[1] as ToolMessage).tool_call_id).toBe("abc123XYZ");
  });

  // Idempotence is what lets this run at the top of every single run: a second pass over history the
  // first pass already fixed must not churn the ids and invalidate the provider's prompt cache.
  it("changes nothing on a second pass over the same history", () => {
    const messages = pair("toolu_01A09q9rDJmwvLpPCJKtxpvB");
    normalizeToolCallIds(messages);
    const afterFirst = (messages[0] as AIMessage).tool_calls![0].id;
    normalizeToolCallIds(messages);
    expect((messages[0] as AIMessage).tool_calls![0].id).toBe(afterFirst);
  });

  it("keeps three parallel calls in one turn distinct and correctly paired", () => {
    const messages: BaseMessage[] = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "toolu_aaa", name: "glob", args: { pattern: "*.ts" } },
          { id: "toolu_bbb", name: "file_read", args: { path: "a.ts" } },
          { id: "toolu_ccc", name: "file_read", args: { path: "b.ts" } },
        ],
      }),
      new ToolMessage({ tool_call_id: "toolu_aaa", content: "a.ts b.ts" }),
      new ToolMessage({ tool_call_id: "toolu_bbb", content: "contents of a" }),
      new ToolMessage({ tool_call_id: "toolu_ccc", content: "contents of b" }),
    ];
    normalizeToolCallIds(messages);

    const calls = (messages[0] as AIMessage).tool_calls!;
    const ids = calls.map((c) => c.id!);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(PORTABLE);
    expect((messages[1] as ToolMessage).tool_call_id).toBe(ids[0]);
    expect((messages[2] as ToolMessage).tool_call_id).toBe(ids[1]);
    expect((messages[3] as ToolMessage).tool_call_id).toBe(ids[2]);
  });

  // The mapping is keyed by the OLD id rather than applied per occurrence. Minting per site would
  // hand these two calls different ids and detach the second from its result.
  it("maps two calls sharing one provider id onto the same new id", () => {
    const messages: BaseMessage[] = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "toolu_dup", name: "glob", args: {} },
          { id: "toolu_dup", name: "glob", args: {} },
        ],
      }),
    ];
    normalizeToolCallIds(messages);
    const calls = (messages[0] as AIMessage).tool_calls!;
    expect(calls[0].id).toBe(calls[1].id);
  });

  it("rewrites an orphaned ToolMessage rather than leaving one rejectable id behind", () => {
    // Already broken — no AIMessage claims it — but a single long id anywhere rejects the whole
    // request, not just its own message, so skipping it would defeat the pass.
    const messages: BaseMessage[] = [new ToolMessage({ tool_call_id: "toolu_orphan", content: "x" })];
    expect(() => normalizeToolCallIds(messages)).not.toThrow();
    expect((messages[0] as ToolMessage).tool_call_id).toMatch(PORTABLE);
  });

  // These two fields are the join keys the usage ledger and the call_agent deep-link rely on
  // (messageSerialization.ts). A rewrite that rebuilt messages instead of mutating ids would drop
  // them, and the loss would only show up as a broken link in a reloaded conversation.
  it("leaves message metadata and non-tool messages alone", () => {
    const messages: BaseMessage[] = [
      new HumanMessage("hello"),
      new AIMessage({
        content: "working",
        tool_calls: [{ id: "toolu_meta", name: "file_read", args: {} }],
        response_metadata: { executionTurnId: "turn-42" },
      }),
      new ToolMessage({
        tool_call_id: "toolu_meta",
        content: "body",
        additional_kwargs: { calleeConversationId: "conv-7" },
      }),
    ];
    normalizeToolCallIds(messages);

    expect((messages[0] as HumanMessage).content).toBe("hello");
    expect((messages[1] as AIMessage).response_metadata.executionTurnId).toBe("turn-42");
    expect((messages[1] as AIMessage).content).toBe("working");
    expect((messages[2] as ToolMessage).additional_kwargs.calleeConversationId).toBe("conv-7");
    expect((messages[2] as ToolMessage).content).toBe("body");
  });

  it("never mints an id that already exists in the history", () => {
    // Without the re-roll the rewritten call would answer a ToolMessage belonging to another call.
    // The first draw reproduces the id the history is keeping; the second must be distinct.
    let draw = 0;
    const random = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation(((array: Uint8Array) => (array.fill(draw++ === 0 ? 0 : 1), array)) as never);

    const messages: BaseMessage[] = [...pair("aaaaaaaaa", "glob"), ...pair("toolu_01LONGPROVIDERID", "file_read")];
    normalizeToolCallIds(messages);

    expect((messages[0] as AIMessage).tool_calls![0].id).toBe("aaaaaaaaa");
    expect((messages[2] as AIMessage).tool_calls![0].id).toBe("bbbbbbbbb");
    expect((messages[3] as ToolMessage).tool_call_id).toBe("bbbbbbbbb");
    random.mockRestore();
  });
});

describe("newToolCallId", () => {
  it("mints ids every provider accepts", () => {
    for (let i = 0; i < 50; i++) expect(newToolCallId()).toMatch(PORTABLE);
  });

  it("does not repeat an id already in the taken set", () => {
    const taken = new Set<string>();
    const ids = Array.from({ length: 200 }, () => newToolCallId(taken));
    expect(new Set(ids).size).toBe(200);
  });
});

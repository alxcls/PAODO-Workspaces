// AgentCallTool's per-(callee, skill) retry bookkeeping — two independent counters
// with different reset rules (contract enforcement lives in executeSkill).

import { describe, it, expect, vi, beforeEach } from "vitest";

// AgentCallTool's contract enforcement lives in executeSkill (tested separately). What is
// unique to the tool is the per-(callee, skill) retry bookkeeping: two independent counters
// with different reset rules, easy to regress because the state is interleaved across calls.
// These tests pin that bookkeeping and nothing else — executeSkill and config are mocked so
// each test scripts only the outcome sequence it cares about.

vi.mock("../skills/executeSkill", () => ({ executeSkill: vi.fn() }));

import { AgentCallTool } from "./agentCall";
import { executeSkill } from "../skills/executeSkill";
import type { SkillCallResult } from "../../workspace/skillTypes";
import type { IWorkspaceStore, IContainerManager } from "../../infra/interfaces";

const mockedExecute = vi.mocked(executeSkill);

const CALLEE = { id: "callee-1", name: "stock-agent" };
const store = {
  getWorkspaceByName: (name: string) => (name === CALLEE.name ? CALLEE : undefined),
  getWorkspace: () => undefined,
} as unknown as IWorkspaceStore;
const containers = {} as IContainerManager;

const INPUT_ERR: SkillCallResult = { state: "failed", code: "INPUT_VALIDATION_ERROR", message: "'sku' is required" };
const NEEDS_INPUT: SkillCallResult = { state: "failed", code: "NEEDS_INPUT", message: "which warehouse?" };

const skillConfig = { skillInputMaxRetries: 2, skillOutputMaxRetries: 2, skillNeedsInputMaxRounds: 2 };

function makeTool() {
  return new AgentCallTool("caller-1", store, containers, skillConfig);
}

// _call is protected; call it directly to drive the counters without zod/invoke wrapping.
function call(tool: AgentCallTool, args: Record<string, unknown> = { sku: "X" }): Promise<string> {
  return (tool as unknown as { _call(i: unknown): Promise<string> })._call({
    workspace: CALLEE.name,
    skill: "check-stock",
    args,
  });
}

beforeEach(() => mockedExecute.mockReset());

describe("AgentCallTool — input-failure streak", () => {
  it("resets the streak on a NEEDS_INPUT in between (args were schema-valid)", async () => {
    // bad → NEEDS_INPUT (valid args) → bad. The middle call breaks the consecutive streak,
    // so the third failure is the FIRST of a new streak, not the terminal second.
    mockedExecute.mockResolvedValueOnce(INPUT_ERR).mockResolvedValueOnce(NEEDS_INPUT).mockResolvedValueOnce(INPUT_ERR);
    const tool = makeTool();

    await call(tool);
    await call(tool);
    const third = await call(tool);

    // If the streak hadn't reset, this third failure would be the 2nd consecutive and carry
    // the terminal "Do NOT retry" guidance.
    expect(third).not.toContain("Do NOT retry");
    expect(third).toContain("INPUT_VALIDATION_ERROR");
  });

  it("cuts off after the configured number of consecutive bad-args calls", async () => {
    mockedExecute.mockResolvedValue(INPUT_ERR);
    const tool = makeTool();

    await call(tool); // streak 1
    const second = await call(tool); // streak 2 → terminal
    expect(second).toContain("Do NOT retry");

    // Third call is rejected by the pre-check guard before executeSkill is even invoked.
    const third = await call(tool);
    expect(third).toContain("consecutive invalid calls");
    expect(mockedExecute).toHaveBeenCalledTimes(2);
  });
});

describe("AgentCallTool — callWithMeta surfaces the callee session link", () => {
  it("returns the callee conversationId as meta while _call returns only the string", async () => {
    mockedExecute.mockResolvedValue({ state: "completed", output: { ok: true }, conversationId: "conv-7" });
    const tool = makeTool();

    const withMeta = await tool.callWithMeta({ workspace: CALLEE.name, skill: "check-stock", args: { sku: "X" } });
    expect(withMeta.meta).toEqual({ conversationId: "conv-7", workspaceId: CALLEE.id, workspaceName: CALLEE.name });
    expect(withMeta.result).toContain('"ok": true');

    const plain = await call(tool);
    expect(typeof plain).toBe("string");
    expect(plain).toContain('"ok": true');
  });

  it("fires onLink with the callee workspace id the moment the callee conversation starts", async () => {
    // executeSkill announces the new conversation via opts.onConversationStart mid-run; the tool
    // must forward it as { conversationId, workspaceId: callee.id } so the link appears live.
    mockedExecute.mockImplementation(async (_callee, _caller, _skillId, _args, opts) => {
      opts?.onConversationStart?.("conv-live");
      return { state: "completed", output: { ok: true }, conversationId: "conv-live" };
    });
    const tool = makeTool();
    const onLink = vi.fn();

    await tool.callWithMeta({ workspace: CALLEE.name, skill: "check-stock", args: { sku: "X" } }, onLink);
    expect(onLink).toHaveBeenCalledWith({
      conversationId: "conv-live",
      workspaceId: CALLEE.id,
      workspaceName: CALLEE.name,
    });
  });

  it("omits meta when the callee never ran (pre-run rejection, no conversationId)", async () => {
    mockedExecute.mockResolvedValue(INPUT_ERR); // no conversationId
    const tool = makeTool();
    const withMeta = await tool.callWithMeta({ workspace: CALLEE.name, skill: "check-stock", args: {} });
    expect(withMeta.meta).toBeUndefined();
  });
});

describe("AgentCallTool — caller cancel cascades into the callee", () => {
  it("threads the caller's signal into executeSkill so a caller Stop reaches the callee", async () => {
    // executeSkill receives a signal that is aborted whenever the caller's signal is — this is
    // what makes Stop on the caller cascade down and halt the in-flight callee run.
    let seenSignal: AbortSignal | undefined;
    mockedExecute.mockImplementation(async (_callee, _caller, _skillId, _args, opts) => {
      seenSignal = opts?.signal;
      return { state: "completed", output: { ok: true }, conversationId: "conv-1" };
    });
    const tool = makeTool();
    const caller = new AbortController();

    await tool.callWithMeta(
      { workspace: CALLEE.name, skill: "check-stock", args: { sku: "X" } },
      undefined,
      caller.signal,
    );
    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(false);
    caller.abort();
    expect(seenSignal!.aborted).toBe(true);
  });

  it("reports a caller cancel as cancelled, not a timeout", async () => {
    // The callee run comes back aborted; the tool must word it as a cancellation (the caller's
    // signal fired) rather than the 5-minute safety timeout.
    const caller = new AbortController();
    caller.abort();
    mockedExecute.mockImplementation(async (_callee, _caller, _skillId, _args, opts) => {
      // Mirror executeSkill: when aborted it returns a failed/aborted result, signal stays aborted.
      void opts;
      return { state: "failed", code: "EXECUTION_ERROR", message: "the call was aborted", conversationId: "conv-1" };
    });
    const tool = makeTool();

    const res = await tool.callWithMeta(
      { workspace: CALLEE.name, skill: "check-stock", args: { sku: "X" } },
      undefined,
      caller.signal,
    );
    expect(res.result).toContain("cancelled");
    expect(res.result).not.toContain("timed out");
  });
});

describe("AgentCallTool — NEEDS_INPUT rounds", () => {
  it("tells the caller to re-call, then cuts off after the configured rounds", async () => {
    mockedExecute.mockResolvedValue(NEEDS_INPUT);
    const tool = makeTool();

    const first = await call(tool); // round 1 → re-call guidance
    // Must start with "Needs input:" so runner.classifyToolStatus tags it as needs_input (amber).
    expect(first).toMatch(/^Needs input:/);
    expect(first).toContain("Re-call the same skill");

    const second = await call(tool); // round 2 → terminal
    expect(second).toContain("stop re-calling this skill");
  });
});

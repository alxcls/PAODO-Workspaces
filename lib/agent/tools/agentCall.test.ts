// AgentCallTool's per-(callee, skill) retry bookkeeping — two independent counters
// with different reset rules (contract enforcement lives in executeSkill).

import { describe, it, expect, vi, beforeEach } from "vitest";

// AgentCallTool's contract enforcement lives in executeSkill (tested separately). What is
// unique to the tool is the per-(callee, skill) retry bookkeeping: two independent counters
// with different reset rules, easy to regress because the state is interleaved across calls.
// These tests pin that bookkeeping and nothing else — executeSkill and config are mocked so
// each test scripts only the outcome sequence it cares about.

vi.mock("../skills/executeSkill", () => ({ executeSkill: vi.fn() }));
// Mock the whole tools/index barrel so importing agentCall doesn't pull in the container /
// workspace-store singletons; only loadAgentConfig is consumed by agentCall.
vi.mock(".", () => ({
  loadAgentConfig: () => ({ skillInputMaxRetries: 2, skillNeedsInputMaxRounds: 2 }),
}));

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

function makeTool() {
  return new AgentCallTool("caller-1", store, containers);
}

// _call is protected; call it directly to drive the counters without zod/invoke wrapping.
function call(tool: AgentCallTool, args: Record<string, unknown> = { sku: "X" }): Promise<string> {
  return (tool as unknown as { _call(i: unknown): Promise<string> })._call({
    workspace: CALLEE.name,
    action: "check-stock",
    args,
  });
}

beforeEach(() => mockedExecute.mockReset());

describe("AgentCallTool — input-failure streak", () => {
  it("resets the streak on a NEEDS_INPUT in between (args were schema-valid)", async () => {
    // bad → NEEDS_INPUT (valid args) → bad. The middle call breaks the consecutive streak,
    // so the third failure is the FIRST of a new streak, not the terminal second.
    mockedExecute
      .mockResolvedValueOnce(INPUT_ERR)
      .mockResolvedValueOnce(NEEDS_INPUT)
      .mockResolvedValueOnce(INPUT_ERR);
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

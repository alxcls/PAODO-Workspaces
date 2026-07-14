// The Workspace-MCP surface must expose ONLY the selected (published) skills and run them through
// executeSkill, mapping the result onto MCP tool results. These pin the selection gate (unselected
// skills are invisible and uncallable) and the completed/failed → MCP-result mapping.

import { describe, it, expect, vi } from "vitest";
import { listWorkspaceMcpTools, callWorkspaceMcpTool, type WorkspaceMcpDeps } from "./workspaceMcpServer";
import type { SkillDefinition } from "../workspace/skillTypes";

const CHECK_STOCK: SkillDefinition = {
  id: "check_stock",
  name: "Check Stock",
  description: "Returns inventory level",
  parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
  output: { type: "object", properties: { in_stock: { type: "boolean" } } },
};
const PLACE_ORDER: SkillDefinition = {
  id: "place_order",
  name: "Place Order",
  description: "",
  parameters: { type: "object", properties: { sku: { type: "string" } } },
  output: { type: "object", properties: { ok: { type: "boolean" } } },
};

function deps(selected: string[], over: Partial<WorkspaceMcpDeps> = {}): WorkspaceMcpDeps {
  return {
    loadSkillsFn: async () => [CHECK_STOCK, PLACE_ORDER],
    getSelectedSkillIds: () => selected,
    getWorkspaceDir: () => "/fake/ws",
    ...over,
  };
}

describe("listWorkspaceMcpTools", () => {
  it("lists only selected skills, mapping id→name, name→title, and both schemas", async () => {
    const tools = await listWorkspaceMcpTools("ws1", deps(["check_stock"]));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "check_stock",
      title: "Check Stock",
      description: "Returns inventory level",
    });
    expect(tools[0].inputSchema).toEqual(CHECK_STOCK.parameters);
    expect(tools[0].outputSchema).toEqual(CHECK_STOCK.output);
  });

  it("omits an empty description rather than sending an empty string", async () => {
    const tools = await listWorkspaceMcpTools("ws1", deps(["place_order"]));
    expect(tools[0].description).toBeUndefined();
  });

  it("returns nothing when the workspace dir cannot be resolved", async () => {
    const tools = await listWorkspaceMcpTools("ws1", deps(["check_stock"], { getWorkspaceDir: () => undefined }));
    expect(tools).toEqual([]);
  });
});

describe("callWorkspaceMcpTool", () => {
  it("rejects a skill that exists but is not selected — without invoking executeSkill", async () => {
    const executeSkillFn = vi.fn();
    const res = await callWorkspaceMcpTool("ws1", "place_order", { sku: "x" }, deps(["check_stock"], { executeSkillFn: executeSkillFn as never }));
    expect(res.isError).toBe(true);
    expect(executeSkillFn).not.toHaveBeenCalled();
  });

  it("maps a completed skill result to structuredContent + text, bypassing the graph check", async () => {
    const executeSkillFn = vi.fn(async (_callee: string, caller: string) => {
      expect(caller).toBe("mcp:ws1");
      return { state: "completed" as const, output: { in_stock: true } };
    });
    const res = await callWorkspaceMcpTool("ws1", "check_stock", { sku: "x" }, deps(["check_stock"], { executeSkillFn: executeSkillFn as never }));
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ in_stock: true });
    expect(res.content[0]).toEqual({ type: "text", text: JSON.stringify({ in_stock: true }) });
  });

  it("surfaces a failed skill result (incl. NEEDS_INPUT) as an MCP tool error with the code", async () => {
    const executeSkillFn = vi.fn(async () => ({ state: "failed" as const, code: "NEEDS_INPUT" as const, message: "which warehouse?" }));
    const res = await callWorkspaceMcpTool("ws1", "check_stock", { sku: "x" }, deps(["check_stock"], { executeSkillFn: executeSkillFn as never }));
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text", text: "[NEEDS_INPUT] which warehouse?" });
  });
});

import { describe, expect, it } from "vitest";
import { getWorkspace, listWorkspaces } from "./read";
import type { Workspace } from "@/lib/workspace/types";

const workspace: Workspace = {
  id: "ws-1",
  name: "Alpha",
  dir: "/private/alpha",
  createdAt: new Date("2026-01-02T03:04:05Z"),
  description: "First workspace",
  maxIterations: 30,
  maxRunMinutes: 20,
  internetAccess: false,
};

const store = {
  listWorkspaces: () => [workspace],
  getWorkspace: (id: string) => (id === workspace.id ? workspace : undefined),
};

describe("workspace record queries", () => {
  it("returns a compact collection shape shared by UI and CLI", () => {
    expect(listWorkspaces(store)).toEqual([
      {
        id: "ws-1",
        name: "Alpha",
        description: "First workspace",
      },
    ]);
  });

  it("returns details without leaking the server directory", () => {
    const result = getWorkspace("ws-1", store);
    expect(result).toMatchObject({
      id: "ws-1",
      name: "Alpha",
      description: "First workspace",
      createdAt: new Date("2026-01-02T03:04:05Z"),
      maxIterations: 30,
      maxRunMinutes: 20,
      internetAccess: false,
      llmProvider: "deepseek",
      llmModel: "deepseek-v4-flash",
    });
    expect(result).not.toHaveProperty("dir");
    expect(result).not.toHaveProperty("reasoningEffort");
    expect(result).not.toHaveProperty("reasoningEffortSupported");
  });

  it("returns an explicitly selected model instead of the defaults", () => {
    const selected: Workspace = {
      ...workspace,
      llmProvider: "openai",
      llmModel: "gpt-5",
      reasoningEffort: "high",
    };
    const result = getWorkspace("ws-1", { ...store, getWorkspace: () => selected });
    expect(result).toMatchObject({
      llmProvider: "openai",
      llmModel: "gpt-5",
      reasoningEffort: "high",
    });
    expect(result).not.toHaveProperty("reasoningEffortSupported");
  });

  it("returns null for an unknown workspace", () => {
    expect(getWorkspace("missing", store)).toBeNull();
  });
});

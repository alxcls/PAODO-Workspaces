// loadAgentConfig resolves provider/model/reasoning-effort from the workspace's stored selection,
// falling back to DEFAULT_LLM (deepseek-v4-pro) when the workspace hasn't picked. The chosen model is
// routed to the selected provider's model field; the other providers' fields stay undefined.
import { describe, it, expect, beforeEach } from "vitest";
import { loadAgentConfig } from "./buildTools";
import { DEFAULT_LLM } from "./interfaces";

// The workspace store singleton is backed by a global map (survives module reloads). loadAgentConfig
// reads it via getWorkspace, so seeding the map directly is enough to exercise the merge.
function seedWorkspace(ws: Record<string, unknown>) {
  const g = global as typeof global & { _workspaces?: Map<string, unknown> };
  if (!g._workspaces) g._workspaces = new Map();
  g._workspaces.set(ws.id as string, ws);
}

describe("loadAgentConfig", () => {
  beforeEach(() => {
    const g = global as typeof global & { _workspaces?: Map<string, unknown> };
    g._workspaces?.clear();
  });

  it("falls back to DEFAULT_LLM when no workspace id is given", () => {
    const c = loadAgentConfig();
    expect(c.provider).toBe(DEFAULT_LLM.provider);
    expect(c.deepseekModel).toBe(DEFAULT_LLM.model);
    expect(c.reasoningEffort).toBe(DEFAULT_LLM.reasoningEffort);
    // Non-selected providers' model fields stay undefined.
    expect(c.anthropicModel).toBeUndefined();
    expect(c.openaiModel).toBeUndefined();
  });

  it("falls back to DEFAULT_LLM for a workspace that hasn't chosen", () => {
    seedWorkspace({ id: "ws-unset", name: "x", dir: "/tmp/x", createdAt: new Date(), maxIterations: 30 });
    const c = loadAgentConfig("ws-unset");
    expect(c.provider).toBe("deepseek");
    expect(c.deepseekModel).toBe("deepseek-v4-pro");
  });

  it("uses the workspace's stored selection and routes the model to the right provider field", () => {
    seedWorkspace({
      id: "ws-anthropic",
      name: "y",
      dir: "/tmp/y",
      createdAt: new Date(),
      maxIterations: 30,
      llmProvider: "anthropic",
      llmModel: "claude-haiku-4-5",
      reasoningEffort: "high",
    });
    const c = loadAgentConfig("ws-anthropic");
    expect(c.provider).toBe("anthropic");
    expect(c.anthropicModel).toBe("claude-haiku-4-5");
    expect(c.reasoningEffort).toBe("high");
    expect(c.deepseekModel).toBeUndefined();
    expect(c.openaiModel).toBeUndefined();
  });
});

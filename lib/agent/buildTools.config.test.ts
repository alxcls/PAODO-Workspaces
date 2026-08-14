// loadAgentConfig resolves provider/model/reasoning-effort from the workspace's stored selection,
// falling back to DEFAULT_LLM (deepseek-v4-flash) when the workspace hasn't picked, and resolves the
// API key from the env var the selected provider's registry entry declares.
import { describe, it, expect, beforeEach } from "vitest";
import { loadAgentConfig } from "./buildTools";
import { buildModel } from "./buildModel";
import { DEFAULT_LLM } from "../models/llmSelection";

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
    expect(c.model).toBe(DEFAULT_LLM.model);
    expect(c.reasoningEffort).toBe(DEFAULT_LLM.reasoningEffort);
  });

  it("falls back to DEFAULT_LLM for a workspace that hasn't chosen", () => {
    seedWorkspace({
      id: "ws-unset",
      name: "x",
      dir: "/tmp/x",
      createdAt: new Date(),
      maxIterations: 30,
      maxRunMinutes: 5,
    });
    const c = loadAgentConfig("ws-unset");
    expect(c.provider).toBe("deepseek");
    expect(c.model).toBe("deepseek-v4-flash");
  });

  it("uses the workspace's stored selection", () => {
    seedWorkspace({
      id: "ws-anthropic",
      name: "y",
      dir: "/tmp/y",
      createdAt: new Date(),
      maxIterations: 30,
      maxRunMinutes: 5,
      llmProvider: "anthropic",
      llmModel: "claude-haiku-4-5",
      reasoningEffort: "high",
    });
    const c = loadAgentConfig("ws-anthropic");
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-haiku-4-5");
    expect(c.reasoningEffort).toBe("high");
  });

  // The key must follow the selected provider — the bug the old per-provider fields allowed was a
  // config carrying every vendor's key at once and the builder picking the wrong one.
  it("resolves the API key from the selected provider's env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.DEEPSEEK_API_KEY = "sk-ds-test";
    seedWorkspace({
      id: "ws-key",
      name: "z",
      dir: "/tmp/z",
      createdAt: new Date(),
      maxIterations: 30,
      maxRunMinutes: 5,
      llmProvider: "anthropic",
      llmModel: "claude-haiku-4-5",
      reasoningEffort: "high",
    });
    expect(loadAgentConfig("ws-key").apiKey).toBe("sk-ant-test");
    // No workspace -> DEFAULT_LLM's provider (deepseek), so its key follows.
    expect(loadAgentConfig().apiKey).toBe("sk-ds-test");
  });

  // internetAccess gates whether apt_install/http_get are bound at all (buildTools' tools array) —
  // loadAgentConfig is where that workspace-stored flag first enters the config.
  it("defaults internetAccess to true for a workspace with no explicit setting", () => {
    seedWorkspace({
      id: "ws-net-default",
      name: "n",
      dir: "/tmp/n",
      createdAt: new Date(),
      maxIterations: 30,
      maxRunMinutes: 5,
    });
    expect(loadAgentConfig("ws-net-default").internetAccess).toBe(true);
  });

  it("follows the workspace's stored internetAccess setting", () => {
    seedWorkspace({
      id: "ws-net-off",
      name: "n",
      dir: "/tmp/n",
      createdAt: new Date(),
      maxIterations: 30,
      maxRunMinutes: 5,
      internetAccess: false,
    });
    expect(loadAgentConfig("ws-net-off").internetAccess).toBe(false);
  });

  // Previously an unknown provider silently fell through to the OpenAI builder, which then failed with
  // a misleading "no openai model selected" (and, upstream, mis-attributed usage to an undefined model).
  it("rejects a provider with no registry entry instead of falling back to another vendor", () => {
    expect(() =>
      buildModel({
        provider: "retired-vendor",
        model: "some-model",
        apiKey: "k",
        reasoningEffort: "low",
        anthropicCacheTtl1h: false,
      }),
    ).toThrow(/unsupported LLM provider "retired-vendor"/);
  });
});

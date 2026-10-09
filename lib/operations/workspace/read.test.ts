import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspace, listWorkspaces } from "./read";
import { providerAvailabilityEnv, SUPPORTED_PROVIDERS } from "@/lib/agent/buildModel";
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

// The fallback for a workspace that never picked is read from .env, so these tests pin it; otherwise
// the developer's shell decides the expected value. Enumerated from the registry, not hand-listed.
function offerOnly(provider: string) {
  for (const p of SUPPORTED_PROVIDERS) {
    vi.stubEnv(providerAvailabilityEnv(p)!, p === provider ? "true" : "false");
  }
}

describe("workspace record queries", () => {
  afterEach(() => vi.unstubAllEnvs());

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
    offerOnly("deepseek");
    const result = getWorkspace("ws-1", store, (provider) => provider === "deepseek");
    expect(result).toMatchObject({
      id: "ws-1",
      name: "Alpha",
      description: "First workspace",
      createdAt: new Date("2026-01-02T03:04:05Z"),
      maxIterations: 30,
      maxRunMinutes: 20,
      internetAccess: false,
      llmProvider: "deepseek",
      llmModel: "deepseek-flash",
      llmProviderHasKey: true,
    });
    expect(result).not.toHaveProperty("dir");
  });

  it("returns an explicitly selected model instead of the defaults", () => {
    const selected: Workspace = {
      ...workspace,
      llmProvider: "openai",
      llmModel: "gpt-5",
      reasoningEffort: "high",
    };
    const result = getWorkspace("ws-1", { ...store, getWorkspace: () => selected }, () => false);
    expect(result).toMatchObject({
      llmProvider: "openai",
      llmModel: "gpt-5",
      llmProviderHasKey: false,
      reasoningEffort: "high",
    });
    expect(result).not.toHaveProperty("reasoningEffortSupported");
  });

  // The fallback follows .env, so the same never-picked workspace reports whichever provider the
  // deployment makes available — never one it switched off.
  it("falls back to the available provider, not a fixed one", () => {
    offerOnly("anthropic");
    expect(getWorkspace("ws-1", store, (provider) => provider === "anthropic")).toMatchObject({
      llmProvider: "anthropic",
      llmModel: "claude-haiku-5-5",
      llmProviderHasKey: true,
      reasoningEffort: "low",
    });
  });

  it("reads provider key availability live instead of storing it on the workspace", () => {
    const hasProviderKey = vi.fn(() => false);
    const result = getWorkspace(
      "ws-1",
      { ...store, getWorkspace: () => ({ ...workspace, llmProvider: "openai" }) },
      hasProviderKey,
    );

    expect(hasProviderKey).toHaveBeenCalledWith("openai");
    expect(result?.llmProviderHasKey).toBe(false);
  });

  it("returns null for an unknown workspace", () => {
    expect(getWorkspace("missing", store)).toBeNull();
  });
});

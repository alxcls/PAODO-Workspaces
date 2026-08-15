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

// What a workspace that never picked falls back to is read from .env, so a test asserting it has to
// pin .env — otherwise whatever the developer's shell exports decides the expected value. Enumerated
// from the registry rather than hand-listed so a new provider can't quietly leak in.
//
// This used to stub only the API-key half of each provider's .env contract, which left the
// availability half free to leak: `ANTHROPIC_AVAILABLE=false` in a shell failed the suite. There is
// now only one half to stub, so the whole class of bug is gone rather than fixed.
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

  // The fallback follows .env, so the same never-picked workspace reports whichever provider the
  // deployment makes available — never one it switched off.
  it("falls back to the available provider, not a fixed one", () => {
    offerOnly("anthropic");
    expect(getWorkspace("ws-1", store)).toMatchObject({
      llmProvider: "anthropic",
      llmModel: "claude-haiku-4-5",
      reasoningEffort: "low",
    });
  });

  it("returns null for an unknown workspace", () => {
    expect(getWorkspace("missing", store)).toBeNull();
  });
});

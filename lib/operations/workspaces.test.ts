import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  metadataWrites,
  validateMetadata,
  type MetadataWriter,
} from "./workspaces";
import type { Workspace } from "@/lib/workspace/workspaceStore";

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

/** Records which setters ran, so a test can assert on order as well as on effect. */
const recordingWriter = (calls: string[], overrides: Partial<MetadataWriter> = {}): MetadataWriter => ({
  renameWorkspace: async () => {
    calls.push("renameWorkspace");
    return true;
  },
  setWorkspaceDescription: () => {
    calls.push("setWorkspaceDescription");
    return true;
  },
  setWorkspaceMaxIterations: () => {
    calls.push("setWorkspaceMaxIterations");
    return true;
  },
  setWorkspaceMaxRunMinutes: () => {
    calls.push("setWorkspaceMaxRunMinutes");
    return true;
  },
  setWorkspaceLlm: () => {
    calls.push("setWorkspaceLlm");
    return true;
  },
  ...overrides,
});

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

  it("creates a workspace with a canonical name and returns its public summary", async () => {
    const create = async (name: string): Promise<Workspace> => {
      expect(name).toBe("Alpha");
      return { ...workspace, name };
    };

    await expect(createWorkspace({ name: "  Alpha  " }, { createWorkspace: create })).resolves.toEqual({
      id: "ws-1",
      name: "Alpha",
      description: "First workspace",
    });
  });

  it("rejects an invalid workspace name before touching the store", async () => {
    const create = async (): Promise<Workspace> => {
      throw new Error("must not create an invalid workspace");
    };

    await expect(createWorkspace({ name: "team/invoices" }, { createWorkspace: create })).rejects.toMatchObject({
      code: "WORKSPACE_NAME_INVALID",
    });
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
      llmModel: "deepseek-v4-pro",
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

describe("workspace metadata validation", () => {
  // The workspace's stored choice, which a partial model request resolves against.
  const CURRENT = { provider: "openai", model: "gpt-5.4", reasoningEffort: "high" as const };

  it("canonicalizes the values it accepts", () => {
    expect(
      validateMetadata({
        name: "  Renamed  ",
        description: "  Updated description  ",
        maxIterations: 42.8,
        maxRunMinutes: 25.9,
        model: { provider: "openai", model: " gpt-5 ", reasoningEffort: "high" },
      }),
    ).toEqual({
      metadata: {
        name: "Renamed",
        description: "Updated description",
        maxIterations: 42,
        maxRunMinutes: 25,
        model: { provider: "openai", model: "gpt-5", reasoningEffort: "high" },
      },
      warnings: [],
    });
  });

  it("returns nothing for an empty input rather than inventing defaults", () => {
    expect(validateMetadata({})).toEqual({ metadata: {}, warnings: [] });
  });

  // An explicitly empty description clears it; an omitted one is left alone. Only the absent key
  // means "unchanged", so the distinction has to survive validation.
  it("keeps an explicitly blank description as a value to write", () => {
    expect(validateMetadata({ description: "   " }).metadata).toEqual({ description: "" });
    expect(validateMetadata({}).metadata).not.toHaveProperty("description");
  });

  it("rejects out-of-range limits instead of clamping them", () => {
    for (const value of [0, -5, 501]) {
      expect(() => validateMetadata({ maxIterations: value })).toThrow("maxIterations must be between 1 and 500");
    }
    expect(() => validateMetadata({ maxRunMinutes: 0 })).toThrow("maxRunMinutes must be between");
  });

  // The rejection is the only place a caller learns the accepted values, so the message content is
  // part of the contract, not decoration.
  it("names the accepted values when a model field is invalid", () => {
    expect(() => validateMetadata({ model: { provider: "unknown", model: "x" } })).toThrow(
      "llmProvider must be one of: anthropic, openai",
    );
    expect(() => validateMetadata({ model: { provider: "openai", model: "gpt-5", reasoningEffort: "nope" } })).toThrow(
      "reasoningEffort for openai must be one of: ",
    );
  });

  // The pairing check. The picker cannot express an incoherent pair, so this is the only thing standing
  // between a programmatic caller and a selection that fails when the run reaches the provider.
  it("refuses a model the provider does not serve, naming the ones it does", () => {
    // Another provider's model, which is well-formed and entirely wrong.
    expect(() => validateMetadata({ model: { provider: "anthropic", model: "gpt-5.5" } })).toThrow(
      "llmModel for anthropic must be one of: claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5",
    );
    // A typo is refused the same way: near-miss is not a category we treat gently.
    expect(() => validateMetadata({ model: { provider: "moonshot", model: "kimi-k4" } })).toThrow(
      "llmModel for moonshot must be one of: kimi-k3",
    );
  });

  // Strict means the resolved pair is checked, not just a supplied one: a model that left the catalog
  // stops being savable even when the caller only meant to change the effort beside it.
  it("refuses a carried-over model that is no longer in the catalog", () => {
    expect(() =>
      validateMetadata({ model: { reasoningEffort: "high" } }, { ...CURRENT, model: "gpt-4o-retired" }),
    ).toThrow("llmModel for openai must be one of: ");
  });

  // A supplied blank is a value the caller tried to set, so it is refused rather than resolved away —
  // otherwise the substitute would come back as a success for a field they got wrong.
  it("refuses a present-but-blank model field instead of defaulting it", () => {
    expect(() => validateMetadata({ model: { provider: "openai", model: "  " } })).toThrow("llmModel required");
    expect(() => validateMetadata({ model: { provider: "   " } })).toThrow("llmProvider must be one of: ");
  });

  // The point of resolution: naming one field is a complete request. Without this a programmatic caller
  // has to send all three, which is knowledge only the picker had.
  it("resolves a partial model choice against the current selection", () => {
    // Provider only: the new provider's first catalog model, and its default effort rather than the
    // level the previous provider was on.
    expect(validateMetadata({ model: { provider: "anthropic" } }, CURRENT).metadata.model).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-8",
      reasoningEffort: "low",
    });
    // Model only: stays on the current provider and resets effort to that provider's default.
    expect(validateMetadata({ model: { model: "gpt-5.1" } }, CURRENT).metadata.model).toEqual({
      provider: "openai",
      model: "gpt-5.1",
      reasoningEffort: "low",
    });
    // Effort only: neither provider nor model is re-picked.
    expect(validateMetadata({ model: { reasoningEffort: "low" } }, CURRENT).metadata.model).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: "low",
    });
  });

  // The reason the switch resets rather than reuses: moonshot has no "medium", so carrying the level
  // over would store a selection it rejects at call time.
  it("resets the effort on a provider switch instead of reusing the previous level", () => {
    expect(
      validateMetadata({ model: { provider: "moonshot" } }, { ...CURRENT, reasoningEffort: "medium" }).metadata.model,
    ).toMatchObject({ provider: "moonshot", reasoningEffort: "low" });
  });

  // DeepSeek takes no effort, so a caller cannot supply a valid one. Substituting the default keeps a
  // provider switch from failing on a field that provider ignores.
  it("substitutes the default effort for a provider with no effort dial", () => {
    expect(validateMetadata({ model: { provider: "deepseek", model: "deepseek-v4-pro" } }).metadata).toMatchObject({
      model: { provider: "deepseek", reasoningEffort: "low" },
    });
  });

  // Dropping it silently is what made the CLI confusing: the response said ok and the effort was
  // unchanged, with nothing explaining why.
  it("warns when an effort is supplied to a provider that has no dial", () => {
    const { metadata, warnings } = validateMetadata(
      { model: { provider: "deepseek", reasoningEffort: "high" } },
      CURRENT,
    );
    expect(metadata.model).toMatchObject({ provider: "deepseek", reasoningEffort: "low" });
    expect(warnings).toEqual(["deepseek has no reasoning effort dial; the supplied reasoningEffort was ignored"]);
  });
});

describe("workspace metadata writes", () => {
  it("emits one write per supplied field, in a fixed order", () => {
    const calls: string[] = [];
    const writes = metadataWrites(
      "ws-1",
      {
        model: { provider: "openai", model: "gpt-5", reasoningEffort: "high" },
        name: "Renamed",
        maxRunMinutes: 25,
        description: "updated",
        maxIterations: 42,
      },
      recordingWriter(calls),
    );

    // Declared out of order above on purpose: the order is the descriptor list's, not the caller's.
    expect(writes.map((w) => w.field)).toEqual(["name", "description", "maxIterations", "maxRunMinutes", "model"]);
  });

  it("emits nothing for fields the caller omitted", () => {
    const calls: string[] = [];
    const writes = metadataWrites("ws-1", { description: "only this" }, recordingWriter(calls));

    expect(writes.map((w) => w.field)).toEqual(["description"]);
    // Building the descriptors must not perform them; nothing runs until the caller asks.
    expect(calls).toEqual([]);
  });

  it("performs the write only when its descriptor is invoked, and reports the store's answer", async () => {
    const calls: string[] = [];
    const writes = metadataWrites(
      "ws-1",
      { name: "Renamed", maxIterations: 42 },
      recordingWriter(calls, { setWorkspaceMaxIterations: () => false }),
    );

    expect(await writes[0].write()).toBe(true);
    expect(await writes[1].write()).toBe(false);
    expect(calls).toEqual(["renameWorkspace"]);
  });
});

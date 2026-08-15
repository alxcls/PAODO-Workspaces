import { describe, expect, it } from "vitest";
import { metadataWrites, validateMetadata, type MetadataWriter, type WorkspaceMetadataInput } from "./metadata";
import { AppError } from "@/lib/errors/appError";

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

describe("workspace metadata validation", () => {
  // The workspace's stored choice, which a partial model request resolves against.
  const CURRENT = { provider: "openai", model: "gpt-5.4", reasoningEffort: "high" as const };

  it("canonicalizes the values it accepts", () => {
    expect(
      validateMetadata({
        name: "  Renamed  ",
        description: "  Updated description  ",
        maxIterations: 42,
        maxRunMinutes: 25,
        model: { provider: "openai", model: " gpt-5 ", reasoningEffort: "high" },
      }),
    ).toEqual({
      name: "Renamed",
      description: "Updated description",
      maxIterations: 42,
      maxRunMinutes: 25,
      model: { provider: "openai", model: "gpt-5", reasoningEffort: "high" },
    });
  });

  it("returns nothing for an empty input rather than inventing defaults", () => {
    expect(validateMetadata({})).toEqual({});
  });

  // An explicitly empty description clears it; an omitted one is left alone. Only the absent key
  // means "unchanged", so the distinction has to survive validation.
  it("keeps an explicitly blank description as a value to write", () => {
    expect(validateMetadata({ description: "   " })).toEqual({ description: "" });
    expect(validateMetadata({})).not.toHaveProperty("description");
  });

  it("rejects a description longer than 4,000 characters", () => {
    expect(() => validateMetadata({ description: "x".repeat(4_001) })).toThrow(
      "description cannot exceed 4000 characters",
    );
  });

  it("rejects non-integer and out-of-range limits instead of normalizing them", () => {
    for (const value of [1.1, 42.8, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateMetadata({ maxIterations: value })).toThrow(
        "maxIterations must be an integer between 1 and 500",
      );
    }
    expect(() => validateMetadata({ maxRunMinutes: 25.9 })).toThrow(
      "maxRunMinutes must be an integer between 1 and 1440",
    );
    for (const value of [0, -5, 501]) {
      expect(() => validateMetadata({ maxIterations: value })).toThrow(
        "maxIterations must be an integer between 1 and 500",
      );
    }
    expect(() => validateMetadata({ maxRunMinutes: 0 })).toThrow("maxRunMinutes must be an integer between");
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
      "llmModel for anthropic must be one of: claude-haiku-4-5, claude-sonnet-5, claude-opus-4-8",
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

  /**
   * The declared input types bind in-process callers; a JSON body only claims to match them. Every
   * string-shaped field is therefore checked at runtime too, because the alternative is not a lenient
   * accept — it is `.trim()` raising a TypeError, which is not an AppError, so it escapes this layer
   * as an opaque 500 instead of the named rejection every other bad value gets. Asserted as
   * WorkspaceUpdateError rather than by message, since the code is what decides that status.
   */
  it("refuses a wrong-typed value on every string-shaped field", () => {
    const cases: WorkspaceMetadataInput[] = [
      { name: 123 as never },
      { description: 123 as never },
      { description: null as never },
      { model: { provider: 5 as never } },
      { model: { model: 5 as never } },
      { model: { reasoningEffort: 5 as never } },
    ];
    for (const input of cases) {
      expect(() => validateMetadata(input, CURRENT)).toThrow(AppError);
    }
  });

  // The reasoningEffort guard is type-only, unlike provider and model: blank already meant "omitted"
  // here and resolves to the provider's default, so tightening it would be a separate contract change.
  it("still treats a blank effort as omitted rather than refusing it", () => {
    expect(validateMetadata({ model: { reasoningEffort: "  " } }, CURRENT).model).toEqual(CURRENT);
  });

  // The point of resolution: naming one field is a complete request. Without this a programmatic caller
  // has to send all three, which is knowledge only the picker had.
  it("resolves a partial model choice against the current selection", () => {
    // Provider only: the new provider's first catalog model, and its default effort rather than the
    // level the previous provider was on.
    expect(validateMetadata({ model: { provider: "anthropic" } }, CURRENT).model).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      reasoningEffort: "low",
    });
    // Model only: stays on the current provider and resets effort to that provider's default.
    expect(validateMetadata({ model: { model: "gpt-5.1" } }, CURRENT).model).toEqual({
      provider: "openai",
      model: "gpt-5.1",
      reasoningEffort: "low",
    });
    // Effort only: neither provider nor model is re-picked.
    expect(validateMetadata({ model: { reasoningEffort: "low" } }, CURRENT).model).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: "low",
    });
  });

  // The reason the switch resets rather than reuses: moonshot has no "medium", so carrying the level
  // over would store a selection it rejects at call time.
  it("resets the effort on a provider switch instead of reusing the previous level", () => {
    expect(
      validateMetadata({ model: { provider: "moonshot" } }, { ...CURRENT, reasoningEffort: "medium" }).model,
    ).toMatchObject({ provider: "moonshot", reasoningEffort: "low" });
  });

  // DeepSeek takes no effort, so a caller cannot supply a valid one. Substituting the default keeps a
  // provider switch from failing on a field that provider ignores.
  it("substitutes the default effort for a provider with no effort dial", () => {
    expect(validateMetadata({ model: { provider: "deepseek", model: "deepseek-v4-pro" } })).toMatchObject({
      model: { provider: "deepseek", reasoningEffort: "low" },
    });
  });

  // An explicit setting the provider cannot persist is a rejected request, never a successful write
  // with a warning. This keeps programmatic triggers aligned with the UI, where the dial is absent.
  it("rejects an effort supplied to a provider that has no dial", () => {
    expect(() => validateMetadata({ model: { provider: "deepseek", reasoningEffort: "high" } }, CURRENT)).toThrow(
      "reasoningEffort is not supported for deepseek",
    );
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

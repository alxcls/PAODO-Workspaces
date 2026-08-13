// Coverage for the update contract itself — the guarantees no single capability can provide.
//
// Each field's own rules are tested where they live (metadata, secrets, access, and egress). What is
// asserted here is composition: that nothing is written until the whole
// request validates, that the fields land in a fixed order, and that what landed is reported
// accurately even when the workspace disappears halfway through.
import { describe, expect, it } from "vitest";
import { updateWorkspace, type UpdateWorkspaceDeps, type UpdateWorkspaceStore } from "./update";
import type { ChannelCredentials } from "./access";
import type { EgressServices } from "./egress";
import type { SecretStore } from "./secrets";
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

/** An all-succeed store; each test overrides only the setters whose behavior it is asserting. */
const storeStub = (overrides: Partial<UpdateWorkspaceStore> = {}): UpdateWorkspaceStore => ({
  getWorkspace: () => workspace,
  renameWorkspace: async () => true,
  setWorkspaceDescription: () => true,
  setWorkspaceMaxIterations: () => true,
  setWorkspaceMaxRunMinutes: () => true,
  setWorkspaceLlm: () => true,
  setWorkspaceInternetAccess: () => true,
  ...overrides,
});

const credentialStub = (overrides: Partial<ChannelCredentials> = {}): ChannelCredentials => ({
  setEnabled: () => {},
  ...overrides,
});

const egressStub = (overrides: Partial<EgressServices> = {}): EgressServices => ({
  setPolicy: () => {},
  applyToContainer: async () => {},
  ...overrides,
});

const secretStub = (overrides: Partial<SecretStore> = {}): SecretStore => ({
  save: (_id, name) => ({ name, createdAt: "2026-08-03T00:00:00.000Z", domains: ["api.example.com"] }),
  read: () => [],
  ...overrides,
});

/** Every seam stubbed, so a test that forgets one cannot reach the real infra by accident. */
const deps = (overrides: UpdateWorkspaceDeps = {}): UpdateWorkspaceDeps => ({
  store: storeStub(),
  credentials: credentialStub(),
  egress: egressStub(),
  secrets: secretStub(),
  ...overrides,
});

describe("the update contract", () => {
  it("applies a partial update and names the fields that landed", async () => {
    const mutable = { ...workspace };
    const store = storeStub({
      getWorkspace: () => mutable,
      renameWorkspace: async (_id, name) => {
        mutable.name = name;
        return true;
      },
      setWorkspaceDescription: (_id, description) => {
        mutable.description = description;
        return true;
      },
    });

    await expect(
      updateWorkspace("ws-1", { name: "  Renamed  ", description: "  Updated description  " }, deps({ store })),
    ).resolves.toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: ["name", "description"],
      values: { name: "Renamed", description: "Updated description" },
    });
    expect(mutable).toMatchObject({ name: "Renamed", description: "Updated description" });
  });

  it("reports a model write with the public workspace field names", async () => {
    const result = await updateWorkspace(
      "ws-1",
      { model: { provider: "openai", model: "gpt-5", reasoningEffort: "high" } },
      deps(),
    );

    expect(result).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: ["llmProvider", "llmModel", "reasoningEffort"],
      values: { llmProvider: "openai", llmModel: "gpt-5", reasoningEffort: "high" },
    });
    expect(result?.applied).toEqual(Object.keys(result?.values ?? {}));
  });

  it("omits a provider's internal effort placeholder from its public receipt", async () => {
    const result = await updateWorkspace("ws-1", { model: { provider: "deepseek", model: "deepseek-v4-pro" } }, deps());

    expect(result).toMatchObject({
      applied: ["llmProvider", "llmModel"],
      values: { llmProvider: "deepseek", llmModel: "deepseek-v4-pro" },
    });
    expect(result?.values).not.toHaveProperty("reasoningEffort");
    expect(result?.values).not.toHaveProperty("model");
  });

  it("does not read the workspace back after a successful metadata write", async () => {
    let reads = 0;
    const store = storeStub({
      getWorkspace: () => {
        reads += 1;
        return workspace;
      },
    });

    await expect(updateWorkspace("ws-1", { description: "updated" }, deps({ store }))).resolves.toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: ["description"],
      values: { description: "updated" },
    });
    expect(reads).toBe(1);
  });

  it("returns null for an unknown workspace without attempting a write", async () => {
    const refuse = () => {
      throw new Error("must not write to a missing workspace");
    };
    const store = storeStub({
      getWorkspace: () => undefined,
      renameWorkspace: refuse,
      setWorkspaceDescription: refuse,
      setWorkspaceMaxIterations: refuse,
      setWorkspaceMaxRunMinutes: refuse,
      setWorkspaceLlm: refuse,
      setWorkspaceInternetAccess: refuse,
    });

    await expect(updateWorkspace("missing", { name: "Renamed" }, deps({ store }))).resolves.toBeNull();
  });

  // The reason validation is a separate phase rather than per-field: a request carrying one bad value
  // must change nothing at all, so a caller never has to work out which half of it survived.
  it("writes nothing when any supplied field is invalid", async () => {
    let writes = 0;
    const store = storeStub({
      setWorkspaceDescription: () => {
        writes += 1;
        return true;
      },
      renameWorkspace: async () => {
        writes += 1;
        return true;
      },
    });

    await expect(
      updateWorkspace("ws-1", { description: "valid", model: { provider: "unknown", model: "x" } }, deps({ store })),
    ).rejects.toThrow("llmProvider must be one of: ");
    expect(writes).toBe(0);
  });

  // The cross-capability case: a bad secret has to stop a perfectly good rename, even though the two are
  // validated and applied by different modules.
  it("writes nothing when a field owned by another capability is invalid", async () => {
    let renames = 0;
    const store = storeStub({
      renameWorkspace: async () => {
        renames += 1;
        return true;
      },
    });
    const secrets = secretStub({
      save: () => {
        throw new Error("must not store an invalid secret");
      },
    });

    await expect(
      updateWorkspace(
        "ws-1",
        { name: "Renamed", secret: { name: "bad-name", value: "v", domains: ["api.example.com"] } },
        deps({ store, secrets }),
      ),
    ).rejects.toThrow("name must be uppercase");
    expect(renames).toBe(0);
  });

  // Reporting this as not-found would tell the caller nothing happened, when a rename already landed.
  // Only an unknown id at the very start is a not-found; a refusal afterwards is a vanished workspace.
  it("names what it applied when the workspace disappears mid-update", async () => {
    const store = storeStub({ setWorkspaceMaxIterations: () => false });

    await expect(
      updateWorkspace("ws-1", { name: "Renamed", description: "kept", maxIterations: 10 }, deps({ store })),
    ).rejects.toThrow("workspace was deleted while updating; applied: name, description; not applied: maxIterations");
  });

  it("says nothing was applied when the very first write refuses", async () => {
    const store = storeStub({ renameWorkspace: async () => false });

    await expect(updateWorkspace("ws-1", { name: "Renamed" }, deps({ store }))).rejects.toThrow(
      "applied: nothing; not applied: name",
    );
  });

  it("reports a vanished workspace the same way when egress is the field that refuses", async () => {
    const store = storeStub({ setWorkspaceInternetAccess: () => false });

    await expect(
      updateWorkspace("ws-1", { description: "kept", internetAccess: true }, deps({ store })),
    ).rejects.toThrow("applied: description; not applied: internetAccess");
  });

  it("fails rather than reporting success when container teardown fails", async () => {
    const egress = egressStub({
      applyToContainer: async () => {
        throw new Error("docker daemon unavailable");
      },
    });

    await expect(updateWorkspace("ws-1", { internetAccess: true }, deps({ egress }))).rejects.toThrow(
      "failed to apply internet-access setting",
    );
  });

  // The security property this whole result shape rests on: an update moves access flags and nothing
  // else, so no caller of this operation — HTTP route, CLI, MCP adapter — can obtain a plaintext key
  // as a side effect of a request it made for another reason, or lose one by not reading a field.
  it("opens both channels without producing a credential", async () => {
    const opened: Array<[string, boolean]> = [];
    const credentials = credentialStub({ setEnabled: (channel, _id, enabled) => opened.push([channel, enabled]) });

    const result = await updateWorkspace(
      "ws-1",
      { workspaceApiAccess: true, workspaceMcpAccess: true },
      deps({ credentials }),
    );

    expect(opened).toEqual([
      ["workspace-api", true],
      ["workspace-mcp", true],
    ]);
    expect(result?.applied).toEqual(["workspaceApiAccess", "workspaceMcpAccess"]);
    expect(result?.values).toEqual({ workspaceApiAccess: true, workspaceMcpAccess: true });
    // Asserted on the key set, not on one name: any future field carrying plaintext fails here.
    expect(Object.keys(result ?? {}).sort()).toEqual(["applied", "ok", "values", "workspaceId"]);
  });

  it("returns stored-secret metadata as capability output without echoing the workspace", async () => {
    const result = await updateWorkspace(
      "ws-1",
      { secret: { name: "API_TOKEN", value: "top-secret", domains: ["API.EXAMPLE.COM"] } },
      deps(),
    );

    expect(result?.applied).toEqual(["secret"]);
    expect(result?.values.secret).toEqual({
      name: "API_TOKEN",
      createdAt: "2026-08-03T00:00:00.000Z",
      domains: ["api.example.com"],
      // The fixture workspace has no egress, so the key it just stored cannot be spent yet.
      blockedBy: "internetAccess",
    });
    expect(result?.values.secret).not.toHaveProperty("value");
    expect(result).not.toHaveProperty("workspace");
  });

  it("omits the secret key entirely when the request carried none", async () => {
    const result = await updateWorkspace("ws-1", { description: "only this" }, deps());
    expect(result?.values).not.toHaveProperty("secret");
  });

  // The order is part of the contract: `applied` is what a caller reads to tell a no-op from a
  // half-done update, so it has to mean the same thing on every request.
  it("applies capabilities in a fixed order regardless of the input's key order", async () => {
    const order: string[] = [];
    const store = storeStub({
      setWorkspaceDescription: () => {
        order.push("description");
        return true;
      },
      setWorkspaceInternetAccess: () => {
        order.push("egress");
        return true;
      },
    });

    const result = await updateWorkspace(
      "ws-1",
      {
        secret: { name: "API_TOKEN", value: "v", domains: ["api.example.com"] },
        workspaceApiAccess: true,
        internetAccess: true,
        description: "updated",
      },
      deps({
        store,
        credentials: credentialStub({ setEnabled: () => order.push("channel") }),
        secrets: secretStub({
          save: (_id, name) => {
            order.push("secret");
            return { name, createdAt: "2026-08-03T00:00:00.000Z", domains: ["api.example.com"] };
          },
        }),
      }),
    );

    expect(order).toEqual(["description", "egress", "channel", "secret"]);
    expect(result?.applied).toEqual(["description", "internetAccess", "workspaceApiAccess", "secret"]);
    expect(result?.values).toMatchObject({
      description: "updated",
      internetAccess: true,
      workspaceApiAccess: true,
      secret: { name: "API_TOKEN", domains: ["api.example.com"] },
    });
    expect(result?.applied).toEqual(Object.keys(result?.values ?? {}));
  });
});

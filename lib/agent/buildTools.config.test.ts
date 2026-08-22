// loadAgentConfig resolves provider/model/reasoning-effort from the workspace's stored selection,
// falling back to the first AVAILABLE provider when the workspace hasn't picked, and resolves the
// API key for the selected provider from the encrypted key store the operator fills in from the UI.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadAgentConfig } from "./buildTools";
import { buildModel, SUPPORTED_PROVIDERS, providerAvailabilityEnv } from "./buildModel";
import { setProviderKey, _resetProviderKeysForTest } from "../infra/security/providerKeyStore";

// The workspace store singleton is backed by a global map (survives module reloads). loadAgentConfig
// reads it via getWorkspace, so seeding the map directly is enough to exercise the merge.
function seedWorkspace(ws: Record<string, unknown>) {
  const g = global as typeof global & { _workspaces?: Map<string, unknown> };
  if (!g._workspaces) g._workspaces = new Map();
  g._workspaces.set(ws.id as string, ws);
}

// The availability vars loadAgentConfig reads, restored after each test so one case's configuration
// can't decide another's fallback.
//
// Derived from the provider registry rather than hand-listed: the fallback these tests exercise is
// "first AVAILABLE provider", so a var this list forgets is a var the developer's own shell still
// supplies — quietly changing which provider the fallback picks, in whichever direction their
// machine happens to be configured. A hand-written list stops covering the newest provider on the
// day it is added, which is precisely when these tests matter most.
const PROVIDER_ENV = SUPPORTED_PROVIDERS.map((provider) => providerAvailabilityEnv(provider)!).filter(Boolean);

/** Offer exactly one provider, so the fallback's choice is unambiguous. */
function offerOnly(provider: string) {
  for (const other of SUPPORTED_PROVIDERS) delete process.env[providerAvailabilityEnv(other)!];
  process.env[providerAvailabilityEnv(provider)!] = "true";
}

describe("loadAgentConfig", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    const g = global as typeof global & { _workspaces?: Map<string, unknown> };
    g._workspaces?.clear();
    savedEnv = Object.fromEntries(PROVIDER_ENV.map((key) => [key, process.env[key]]));
    // Availability is opt-in, so the baseline has to name every provider; the cases that care about
    // one being withdrawn switch it off themselves.
    for (const key of PROVIDER_ENV) process.env[key] = "true";
    // Keys live in a process-global store now, not the environment, so they leak between tests the
    // same way env vars used to and need clearing for the same reason.
    _resetProviderKeysForTest();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetProviderKeysForTest();
  });

  it("falls back to the first available provider when no workspace id is given", () => {
    offerOnly("deepseek");
    const c = loadAgentConfig();
    expect(c.provider).toBe("deepseek");
    expect(c.model).toBe("deepseek-v4-flash");
  });

  it("falls back to the first available provider for a workspace that hasn't chosen", () => {
    offerOnly("deepseek");
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

  // The bug this pins: the fallback used to be a hardcoded deepseek, so a workspace that had never
  // picked ran (and displayed) deepseek even where .env had switched it off.
  it("skips a provider .env switched off when picking the fallback", () => {
    process.env.DEEPSEEK_AVAILABLE = "false";
    const c = loadAgentConfig();
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-haiku-4-5");
  });

  // The fallback deliberately does NOT prefer a keyed provider. Skipping to one would hide the
  // deployment's real first choice behind whichever provider happened to be paid for, and would make
  // a workspace silently change provider the moment a key was added or removed elsewhere.
  it("picks the first offered provider even when a later one is the only keyed one", () => {
    setProviderKey("deepseek", "sk-ds");
    expect(loadAgentConfig().provider).toBe("anthropic");
    expect(loadAgentConfig().apiKey).toBeUndefined();
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
  // config carrying every vendor's key at once and the builder picking the wrong one. Sending one
  // vendor's credential to another vendor's endpoint leaks it to that third party, so this is a
  // disclosure bug wearing a 401's clothes.
  it("resolves the API key of the selected provider, not of some other one", () => {
    setProviderKey("anthropic", "sk-ant-test");
    setProviderKey("deepseek", "sk-ds-test");
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
    // No workspace -> the fallback provider, whose own key follows. anthropic leads the registry.
    expect(loadAgentConfig().apiKey).toBe("sk-ant-test");
    // ...and deepseek's key once deepseek is the one being offered. Note the fallback follows
    // AVAILABILITY, not which providers happen to be keyed: switching anthropic off alone would land
    // on openai — offered, unkeyed, and therefore a run that stops at the preflight.
    offerOnly("deepseek");
    expect(loadAgentConfig().apiKey).toBe("sk-ds-test");
  });

  // The state every deployment is in before anyone opens the settings modal. undefined is the signal
  // runAgent's preflight turns into "No API key set for anthropic" — it must not become "" or throw.
  it("reports no API key rather than failing when none has been entered", () => {
    seedWorkspace({
      id: "ws-unkeyed",
      name: "z",
      dir: "/tmp/z",
      createdAt: new Date(),
      maxIterations: 30,
      maxRunMinutes: 5,
      llmProvider: "anthropic",
      llmModel: "claude-haiku-4-5",
      reasoningEffort: "high",
    });
    expect(loadAgentConfig("ws-unkeyed").apiKey).toBeUndefined();
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

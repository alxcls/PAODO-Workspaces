// loadAgentConfig resolves provider/model/reasoning-effort from the workspace's stored selection,
// falling back to the first AVAILABLE provider when the workspace hasn't picked, and resolves the
// API key from the env var the selected provider's registry entry declares.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadAgentConfig } from "./buildTools";
import { buildModel, SUPPORTED_PROVIDERS, providerApiKeyEnv, providerAvailabilityEnv } from "./buildModel";

// The workspace store singleton is backed by a global map (survives module reloads). loadAgentConfig
// reads it via getWorkspace, so seeding the map directly is enough to exercise the merge.
function seedWorkspace(ws: Record<string, unknown>) {
  const g = global as typeof global & { _workspaces?: Map<string, unknown> };
  if (!g._workspaces) g._workspaces = new Map();
  g._workspaces.set(ws.id as string, ws);
}

// The provider env vars loadAgentConfig reads, restored after each test so one case's keys can't
// decide another's fallback.
//
// Derived from the provider registry rather than hand-listed: the fallback these tests exercise is
// "first AVAILABLE provider", so a var this list forgets is a var the developer's own shell still
// supplies — quietly changing which provider the fallback picks, in whichever direction their
// machine happens to be configured. A hand-written list stops covering the newest provider on the
// day it is added, which is precisely when these tests matter most.
const PROVIDER_ENV = SUPPORTED_PROVIDERS.flatMap((provider) =>
  [providerApiKeyEnv(provider), providerAvailabilityEnv(provider)].filter((v): v is string => Boolean(v)),
);

describe("loadAgentConfig", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    const g = global as typeof global & { _workspaces?: Map<string, unknown> };
    g._workspaces?.clear();
    savedEnv = Object.fromEntries(PROVIDER_ENV.map((key) => [key, process.env[key]]));
    for (const key of PROVIDER_ENV) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("falls back to the first available provider when no workspace id is given", () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds";
    const c = loadAgentConfig();
    expect(c.provider).toBe("deepseek");
    expect(c.model).toBe("deepseek-v4-flash");
  });

  it("falls back to the first available provider for a workspace that hasn't chosen", () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds";
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
    process.env.DEEPSEEK_API_KEY = "sk-ds";
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.DEEPSEEK_AVAILABLE = "false";
    const c = loadAgentConfig();
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-haiku-4-5");
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
    // No workspace -> the fallback provider, whose own key follows. anthropic leads the registry, so
    // with both keys set that is anthropic.
    expect(loadAgentConfig().apiKey).toBe("sk-ant-test");
    // ...and deepseek's key once anthropic is out of the running.
    process.env.ANTHROPIC_AVAILABLE = "false";
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

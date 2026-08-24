// internetAccess gates whether apt_install/http_get are BOUND at all — not just whether they'd
// error if called. This pins the actual tools array, since that's the real defense: a model can't
// emit a tool call for a tool it was never given, regardless of what a prompt injection asks for.

import { describe, it, expect } from "vitest";
import { buildTools } from "./buildTools";
import type { AgentConfig } from "./interfaces";
import type { IContainerManager, IWorkspaceStore, IWorkspaceVersioning } from "../infra/interfaces";

const containers = {} as IContainerManager;
const store = { getWorkspace: () => undefined } as unknown as IWorkspaceStore;
const versioning = {} as IWorkspaceVersioning;

const baseConfig: AgentConfig = {
  provider: "anthropic",
  reasoningEffort: "low",
  model: "claude-haiku-4-5",
  apiKey: "sk-ant-test",
  anthropicCacheTtl1h: false,
  internetAccess: true,
  silenceTimeoutMs: 60_000,
  maxTimeoutMs: 30 * 60_000,
  skillInputMaxRetries: 2,
  skillOutputMaxRetries: 2,
  skillNeedsInputMaxRounds: 2,
};

describe("buildTools — internetAccess gating", () => {
  it("binds http_get and apt_install when internet access is on", () => {
    const { toolMap } = buildTools(
      "ws1",
      "/tmp/ws1",
      { ...baseConfig, internetAccess: true },
      { containers, store, versioning },
    );
    expect(toolMap.http_get).toBeDefined();
    expect(toolMap.apt_install).toBeDefined();
  });

  it("drops http_get and apt_install entirely when internet access is off", () => {
    const { toolMap } = buildTools(
      "ws1",
      "/tmp/ws1",
      { ...baseConfig, internetAccess: false },
      { containers, store, versioning },
    );
    expect(toolMap.http_get).toBeUndefined();
    expect(toolMap.apt_install).toBeUndefined();
  });

  it("leaves every other tool unaffected by the toggle", () => {
    const on = buildTools(
      "ws1",
      "/tmp/ws1",
      { ...baseConfig, internetAccess: true },
      { containers, store, versioning },
    );
    const off = buildTools(
      "ws1",
      "/tmp/ws1",
      { ...baseConfig, internetAccess: false },
      { containers, store, versioning },
    );
    const otherToolsOn = Object.keys(on.toolMap).filter((n) => n !== "http_get" && n !== "apt_install");
    const otherToolsOff = Object.keys(off.toolMap).filter((n) => n !== "http_get" && n !== "apt_install");
    expect(otherToolsOff.sort()).toEqual(otherToolsOn.sort());
  });
});

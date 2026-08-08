import { describe, expect, it } from "vitest";
import {
  getWorkspaceAccess,
  setChannelEnabled,
  validateChannelEnabled,
  type AccessChannel,
  type ChannelCredentials,
} from "./access";

const credentialStub = (overrides: Partial<ChannelCredentials> = {}): ChannelCredentials => ({
  setEnabled: () => {},
  ...overrides,
});

describe("workspace access details", () => {
  it("reports both axes per channel, and no credential", () => {
    const readState = (channel: AccessChannel) =>
      channel === "workspace-api" ? { enabled: true, hasKey: true } : { enabled: false, hasKey: true };

    expect(getWorkspaceAccess("ws-1", "https://agents.example.com/", readState)).toEqual({
      workspaceApiAccess: true,
      workspaceApiHasKey: true,
      apiEndpoint: "https://agents.example.com/api/workspaces/ws-1/agent",
      workspaceMcpAccess: false,
      workspaceMcpHasKey: true,
      mcpConnectionUrl: "https://agents.example.com/api/workspaces/ws-1/mcp",
    });
  });

  // The four combinations of the two axes are all ordinary states, and each needs a different action
  // to become usable: open the channel, issue a key, both, or nothing. A single nullable URL collapsed
  // three of them into one `null`, which told a programmatic caller that something was wrong but never
  // which thing — and the CLI, unlike the UI, has no panel to read the answer off.
  it.each([
    { enabled: false, hasKey: false },
    { enabled: false, hasKey: true },
    { enabled: true, hasKey: false },
    { enabled: true, hasKey: true },
  ])("distinguishes enabled=$enabled from hasKey=$hasKey", ({ enabled, hasKey }) => {
    const access = getWorkspaceAccess("ws-1", "https://agents.example.com", () => ({ enabled, hasKey }));

    expect(access).toMatchObject({
      workspaceApiAccess: enabled,
      workspaceApiHasKey: hasKey,
      workspaceMcpAccess: enabled,
      workspaceMcpHasKey: hasKey,
    });
  });

  // The address is where the workspace lives, not a statement that a call would succeed right now.
  // Withholding it until both axes line up hid the value an operator has to paste into the client
  // they are configuring — precisely while they are configuring it.
  it("reports both addresses even for a closed, keyless channel", () => {
    const readState = () => ({ enabled: false, hasKey: false });

    expect(getWorkspaceAccess("ws-1", "https://agents.example.com", readState)).toMatchObject({
      apiEndpoint: "https://agents.example.com/api/workspaces/ws-1/agent",
      mcpConnectionUrl: "https://agents.example.com/api/workspaces/ws-1/mcp",
    });
  });

  it("escapes the workspace id it puts in a URL", () => {
    const readState = () => ({ enabled: true, hasKey: true });

    expect(getWorkspaceAccess("ws 1/2", "https://agents.example.com", readState).apiEndpoint).toBe(
      "https://agents.example.com/api/workspaces/ws%201%2F2/agent",
    );
  });

  it("tolerates a connection origin with trailing slashes", () => {
    const readState = () => ({ enabled: true, hasKey: true });

    expect(getWorkspaceAccess("ws-1", "https://agents.example.com///", readState).apiEndpoint).toBe(
      "https://agents.example.com/api/workspaces/ws-1/agent",
    );
  });
});

describe("opening and closing a channel", () => {
  // The toggle owns one axis and the credential verbs own the other. Enabling therefore returns
  // nothing at all: a caller that flips this flag can neither obtain a key it did not ask for nor lose
  // one it is holding, in either direction.
  it("moves only the enabled flag, returning no credential", () => {
    const touched: string[] = [];
    const credentials = credentialStub({ setEnabled: () => touched.push("setEnabled") });

    expect(setChannelEnabled("workspace-api", "ws-1", true, credentials)).toBeUndefined();
    expect(setChannelEnabled("workspace-mcp", "ws-1", false, credentials)).toBeUndefined();
    expect(touched).toEqual(["setEnabled", "setEnabled"]);
  });

  it("passes the channel and desired state straight through to the credential store", () => {
    const changes: Array<[string, string, boolean]> = [];
    const credentials = credentialStub({
      setEnabled: (channel, id, enabled) => changes.push([channel, id, enabled]),
    });

    setChannelEnabled("workspace-api", "ws-1", true, credentials);
    setChannelEnabled("workspace-mcp", "ws-1", false, credentials);

    expect(changes).toEqual([
      ["workspace-api", "ws-1", true],
      ["workspace-mcp", "ws-1", false],
    ]);
  });
});

describe("channel input validation", () => {
  it("names the field it rejected, so one message serves both channels", () => {
    expect(() => validateChannelEnabled("workspaceMcpAccess", "yes")).toThrow("workspaceMcpAccess must be a boolean");
    expect(() => validateChannelEnabled("workspaceApiAccess", undefined)).toThrow(
      "workspaceApiAccess must be a boolean",
    );
  });

  it("returns the boolean it accepted", () => {
    expect(validateChannelEnabled("workspaceApiAccess", false)).toBe(false);
  });
});

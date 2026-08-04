import { describe, expect, it } from "vitest";
import {
  getWorkspaceAccess,
  setChannelEnabled,
  validateChannelEnabled,
  type AccessChannel,
  type ChannelCredentials,
} from "./workspaceAccess";

/**
 * Baseline credentials. `hasSecret` reports a key already present and `mint` throws, so minting is
 * never incidental: a test that expects a key to be created has to say so, and one that does not fails
 * loudly if a key gets minted behind its back.
 */
const credentialStub = (overrides: Partial<ChannelCredentials> = {}): ChannelCredentials => ({
  hasSecret: () => true,
  setEnabled: () => {},
  mint: () => {
    throw new Error("must not mint a credential in this test");
  },
  ...overrides,
});

describe("workspace access details", () => {
  it("reports each channel's state and URL without exposing a credential", () => {
    const readState = (channel: AccessChannel) =>
      channel === "workspace-api" ? { enabled: true, hasSecret: true } : { enabled: false, hasSecret: true };

    expect(getWorkspaceAccess("ws-1", "https://agents.example.com/", readState)).toEqual({
      workspaceApiAccess: true,
      apiEndpoint: "https://agents.example.com/api/workspaces/ws-1/agent",
      workspaceMcpAccess: false,
      mcpConnectionUrl: null,
    });
  });

  // An enabled channel normally always has a key, because enabling mints one. Reaching this state means
  // the key was revoked afterwards, and showing a URL for it would advertise an endpoint that 401s.
  it("withholds the URL of an enabled channel whose key was revoked", () => {
    const readState = () => ({ enabled: true, hasSecret: false });

    expect(getWorkspaceAccess("ws-1", "https://agents.example.com", readState)).toMatchObject({
      workspaceApiAccess: true,
      apiEndpoint: null,
      mcpConnectionUrl: null,
    });
  });

  it("escapes the workspace id it puts in a URL", () => {
    const readState = () => ({ enabled: true, hasSecret: true });

    expect(getWorkspaceAccess("ws 1/2", "https://agents.example.com", readState).apiEndpoint).toBe(
      "https://agents.example.com/api/workspaces/ws%201%2F2/agent",
    );
  });

  it("tolerates a connection origin with trailing slashes", () => {
    const readState = () => ({ enabled: true, hasSecret: true });

    expect(getWorkspaceAccess("ws-1", "https://agents.example.com///", readState).apiEndpoint).toBe(
      "https://agents.example.com/api/workspaces/ws-1/agent",
    );
  });
});

describe("opening and closing a channel", () => {
  it("mints a channel's first key so enabling it is enough to make it usable", () => {
    const plain = setChannelEnabled(
      "workspace-api",
      "ws-1",
      true,
      credentialStub({ hasSecret: () => false, mint: () => "pak_first" }),
    );

    expect(plain).toBe("pak_first");
  });

  // Re-enabling must not invalidate a key that consumers already hold, so the baseline stub's throwing
  // `mint` is the assertion: reaching it at all fails the test.
  it("keeps an existing key when a configured channel is enabled again", () => {
    expect(setChannelEnabled("workspace-api", "ws-1", true, credentialStub())).toBeUndefined();
  });

  it("mints again after a revoke, so a dark channel heals on the next enable", () => {
    const plain = setChannelEnabled(
      "workspace-mcp",
      "ws-1",
      true,
      credentialStub({ hasSecret: () => false, mint: () => "mcp_replacement" }),
    );

    expect(plain).toBe("mcp_replacement");
  });

  it("mints nothing when a channel is switched off", () => {
    expect(
      setChannelEnabled("workspace-api", "ws-1", false, credentialStub({ hasSecret: () => false })),
    ).toBeUndefined();
  });

  // Reading after enabling would see the flag we just wrote rather than whether a key predates it, and
  // would mint on every enable — silently invalidating keys consumers already hold.
  it("reads the existing key before flipping the flag", () => {
    const order: string[] = [];
    setChannelEnabled(
      "workspace-api",
      "ws-1",
      true,
      credentialStub({
        hasSecret: () => {
          order.push("hasSecret");
          return false;
        },
        setEnabled: () => order.push("setEnabled"),
        mint: () => {
          order.push("mint");
          return "pak_new";
        },
      }),
    );

    expect(order).toEqual(["hasSecret", "setEnabled", "mint"]);
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

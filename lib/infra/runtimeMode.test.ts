import { describe, expect, it } from "vitest";
import { readRuntimeMode } from "./runtimeMode";

describe("runtime mode", () => {
  it("reads a dev run: hot reload, on the same volume a deployment uses", () => {
    expect(readRuntimeMode({ WORKSPACES_VOLUME_NAME: "paodo_ws_workspaces" })).toEqual({
      hotReload: true,
      workspacesVolume: "paodo_ws_workspaces",
      hardenedBrowser: false,
    });
  });

  it("reads a deployment: prebuilt, on the same volume", () => {
    expect(readRuntimeMode({ NODE_ENV: "production", WORKSPACES_VOLUME_NAME: "paodo_ws_workspaces" })).toEqual({
      hotReload: false,
      workspacesVolume: "paodo_ws_workspaces",
      hardenedBrowser: true,
    });
  });

  // Only the compile strategy separates the two, so the volume is the constant across them.
  it("reports no volume when nothing mounts one, leaving the check to startup", () => {
    expect(readRuntimeMode({}).workspacesVolume).toBeNull();
    expect(readRuntimeMode({ WORKSPACES_VOLUME_NAME: "" }).workspacesVolume).toBeNull();
    expect(readRuntimeMode({ WORKSPACES_VOLUME_NAME: "   " }).workspacesVolume).toBeNull();
  });

  it("trims a volume name so it can be compared and passed to docker verbatim", () => {
    expect(readRuntimeMode({ WORKSPACES_VOLUME_NAME: " paodo_ws_workspaces " }).workspacesVolume).toBe(
      "paodo_ws_workspaces",
    );
  });

  it("hardens the browser origin only outside hot reload", () => {
    expect(readRuntimeMode({ NODE_ENV: "development" }).hardenedBrowser).toBe(false);
    expect(readRuntimeMode({ NODE_ENV: "production" }).hardenedBrowser).toBe(true);
  });
});

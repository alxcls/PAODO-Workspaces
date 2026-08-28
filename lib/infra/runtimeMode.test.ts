import { describe, expect, it } from "vitest";
import { readRuntimeMode } from "./runtimeMode";

describe("runtime mode", () => {
  it("treats an empty environment as the host dev loop", () => {
    expect(readRuntimeMode({})).toEqual({
      hotReload: true,
      workspacesVolume: null,
      containerized: false,
      hardenedBrowser: false,
    });
  });

  it("reads the deployed stack from both axes together", () => {
    expect(readRuntimeMode({ NODE_ENV: "production", WORKSPACES_VOLUME_NAME: "paodo_ws_workspaces" })).toEqual({
      hotReload: false,
      workspacesVolume: "paodo_ws_workspaces",
      containerized: true,
      hardenedBrowser: true,
    });
  });

  // The two axes are independent, so each half alone is a reachable state rather than a mistake
  // to normalize away: `npm run dev` against a compose volume, or a prebuilt server on the host.
  it("keeps the two axes independent", () => {
    const builtOnHost = readRuntimeMode({ NODE_ENV: "production" });
    expect(builtOnHost.hotReload).toBe(false);
    expect(builtOnHost.containerized).toBe(false);

    const hotReloadOnVolume = readRuntimeMode({ WORKSPACES_VOLUME_NAME: "paodo_ws_workspaces" });
    expect(hotReloadOnVolume.hotReload).toBe(true);
    expect(hotReloadOnVolume.containerized).toBe(true);
  });

  it("ignores a blank or whitespace-only volume name", () => {
    expect(readRuntimeMode({ WORKSPACES_VOLUME_NAME: "" }).containerized).toBe(false);
    expect(readRuntimeMode({ WORKSPACES_VOLUME_NAME: "   " }).containerized).toBe(false);
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

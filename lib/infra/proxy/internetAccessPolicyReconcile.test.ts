// The workspace registry is the primary record of a workspace's egress; this file is only the
// sidecar-visible mirror of it, and a missing entry in it reads as ENABLED. So a mirror that was
// lost with its volume, restored from an older backup, or never written fails OPEN while the UI
// still shows the workspace as off. reconcile is what makes the mirror derived rather than precious.

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";

const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "internet-access-reconcile-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

import {
  reconcileInternetAccessPolicy,
  setInternetAccessPolicy,
  isInternetAccessEnabled,
  INTERNET_ACCESS_POLICY_FILE,
} from "./internetAccessPolicy";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const onDisk = () => JSON.parse(fs.readFileSync(INTERNET_ACCESS_POLICY_FILE, "utf-8"));

describe("reconcileInternetAccessPolicy", () => {
  it("rebuilds a mirror that was lost with the .proxy-ca volume", () => {
    fs.rmSync(INTERNET_ACCESS_POLICY_FILE, { force: true });
    reconcileInternetAccessPolicy([
      { id: "ws-off", internetAccess: false },
      { id: "ws-on", internetAccess: true },
    ]);
    expect(isInternetAccessEnabled("ws-off")).toBe(false);
    expect(onDisk()).toEqual({ "ws-off": false });
  });

  it("restores an entry a stale mirror is missing — the drift that fails open", () => {
    fs.writeFileSync(INTERNET_ACCESS_POLICY_FILE, JSON.stringify({ "ws-known-off": false }));
    reconcileInternetAccessPolicy([
      { id: "ws-known-off", internetAccess: false },
      { id: "ws-newly-off", internetAccess: false },
    ]);
    expect(isInternetAccessEnabled("ws-newly-off")).toBe(false);
    expect(onDisk()).toEqual({ "ws-known-off": false, "ws-newly-off": false });
  });

  it("stays sparse: a workspace with no explicit false gets no entry", () => {
    reconcileInternetAccessPolicy([{ id: "ws-default" }, { id: "ws-explicit-on", internetAccess: true }]);
    expect(onDisk()).toEqual({});
    expect(isInternetAccessEnabled("ws-default")).toBe(true);
  });

  it("drops an entry for a workspace the registry no longer has", () => {
    setInternetAccessPolicy("ws-deleted-while-down", false);
    reconcileInternetAccessPolicy([{ id: "ws-kept", internetAccess: false }]);
    expect(onDisk()).toEqual({ "ws-kept": false });
    expect(isInternetAccessEnabled("ws-deleted-while-down")).toBe(true);
  });

  it("throws when the rebuilt policy cannot be persisted, so startup can refuse to serve", () => {
    const blocker = INTERNET_ACCESS_POLICY_FILE + ".tmp";
    fs.mkdirSync(blocker, { recursive: true });
    try {
      expect(() => reconcileInternetAccessPolicy([{ id: "ws-any", internetAccess: false }])).toThrow();
    } finally {
      fs.rmSync(blocker, { recursive: true, force: true });
    }
  });
});

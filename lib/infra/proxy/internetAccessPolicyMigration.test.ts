// The policy file moved into .proxy-ca/ so the credproxy sidecar can mount that directory alone
// instead of the whole workspaces volume. Nothing rebuilds this file from the workspace registry,
// so a deployment that failed to carry it across would silently re-enable every disabled workspace.
// Its own suite because the promotion runs once, at module import, against a pre-seeded legacy file.

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";
import path from "path";

const { ROOT, LEGACY } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "internet-access-migration-test-"));
  const legacy = path.join(root, ".internet-access.json");
  // Seed the pre-move layout: one workspace explicitly turned off, no .proxy-ca yet.
  fs.writeFileSync(legacy, JSON.stringify({ "ws-disabled": false }));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root, LEGACY: legacy };
});

import { isInternetAccessEnabled, INTERNET_ACCESS_POLICY_FILE } from "./internetAccessPolicy";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("internet-access policy migration into .proxy-ca", () => {
  it("carries a disabled workspace across the move", () => {
    expect(isInternetAccessEnabled("ws-disabled")).toBe(false);
    expect(isInternetAccessEnabled("ws-never-toggled")).toBe(true);
  });

  it("writes the policy to the new location the sidecar mounts", () => {
    expect(INTERNET_ACCESS_POLICY_FILE).toBe(path.join(ROOT, ".proxy-ca", "internet-access.json"));
    expect(JSON.parse(fs.readFileSync(INTERNET_ACCESS_POLICY_FILE, "utf-8"))).toEqual({ "ws-disabled": false });
  });

  it("leaves the legacy file in place so a rollback still finds it", () => {
    expect(fs.existsSync(LEGACY)).toBe(true);
  });
});

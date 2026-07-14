// validateSecret is the auth chokepoint for the Workspace-MCP endpoint; these pin that it fails
// closed (disabled / no secret / revoked / wrong) and accepts only the legit case, and that the
// skill selection ("published" set) round-trips and dedupes.

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";

// Redirect the on-disk store to a throwaway temp dir BEFORE mcpConfigStore (via paths.ts) reads
// WORKSPACES_ROOT at import time. vi.hoisted runs above the imports.
const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcpconfig-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

import {
  generateSecret,
  mintSecret,
  revokeSecret,
  setEnabled,
  setSelectedSkills,
  getState,
  validateSecret,
  deleteForWorkspace,
} from "./mcpConfigStore";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// The MCP is OFF by default, so the deny paths are the common runtime states and must fail closed.
// Each test uses a distinct workspace id since the store is a process-global shared across tests.

describe("validateSecret — auth fails closed", () => {
  it("denies a workspace that never enabled MCP (default state)", () => {
    expect(validateSecret("never-configured", "mcp_anything")).toBe(false);
  });

  it("denies even the correct secret when the MCP is disabled", () => {
    mintSecret("ws-disabled"); // returns plain, enables
    const plain = mintSecret("ws-disabled2");
    expect(validateSecret("ws-disabled2", plain)).toBe(true); // sanity while enabled
    setEnabled("ws-disabled2", false);
    expect(validateSecret("ws-disabled2", plain)).toBe(false);
  });

  it("denies a revoked secret even if still enabled", () => {
    const plain = mintSecret("ws-revoked");
    revokeSecret("ws-revoked");
    expect(validateSecret("ws-revoked", plain)).toBe(false);
  });

  it("denies an incorrect secret on an enabled workspace", () => {
    mintSecret("ws-wrong");
    expect(validateSecret("ws-wrong", generateSecret().plain)).toBe(false);
    expect(validateSecret("ws-wrong", "")).toBe(false);
  });
});

describe("validateSecret — authorizes the legitimate case", () => {
  it("accepts the freshly minted secret", () => {
    const plain = mintSecret("ws-valid");
    expect(validateSecret("ws-valid", plain)).toBe(true);
  });

  it("rotates: an old secret stops working after a re-mint", () => {
    const old = mintSecret("ws-rotate");
    const fresh = mintSecret("ws-rotate");
    expect(old).not.toBe(fresh);
    expect(validateSecret("ws-rotate", old)).toBe(false);
    expect(validateSecret("ws-rotate", fresh)).toBe(true);
  });

  it("accepts again after disable then re-enable", () => {
    const plain = mintSecret("ws-toggle");
    setEnabled("ws-toggle", false);
    expect(validateSecret("ws-toggle", plain)).toBe(false);
    setEnabled("ws-toggle", true);
    expect(validateSecret("ws-toggle", plain)).toBe(true);
  });
});

describe("selected skills (the published set)", () => {
  it("round-trips a selection and dedupes while preserving order", () => {
    setSelectedSkills("ws-sel", ["check_stock", "place_order", "check_stock"]);
    expect(getState("ws-sel").selectedSkillIds).toEqual(["check_stock", "place_order"]);
  });

  it("getState returns a copy that cannot mutate the stored selection", () => {
    setSelectedSkills("ws-copy", ["a", "b"]);
    getState("ws-copy").selectedSkillIds.push("c");
    expect(getState("ws-copy").selectedSkillIds).toEqual(["a", "b"]);
  });
});

describe("deleteForWorkspace", () => {
  it("clears all config so the MCP fails closed after workspace deletion", () => {
    const plain = mintSecret("ws-del");
    setSelectedSkills("ws-del", ["x"]);
    deleteForWorkspace("ws-del");
    expect(validateSecret("ws-del", plain)).toBe(false);
    expect(getState("ws-del")).toEqual({ enabled: false, secretHash: null, selectedSkillIds: [] });
  });
});

describe("generateSecret", () => {
  it("returns an mcp_-prefixed secret, unique each call", () => {
    const a = generateSecret();
    expect(a.plain.startsWith("mcp_")).toBe(true);
    expect(a.plain).not.toBe(generateSecret().plain);
  });
});

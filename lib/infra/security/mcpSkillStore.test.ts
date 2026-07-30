// The published skill set is what an MCP client is allowed to see and call, so a selection that
// silently grows (duplicates, non-strings) or that a caller can mutate after reading is a real
// exposure bug rather than a tidiness one. Auth for the endpoint is covered by credentialStore.test.ts.

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";

// Redirect the on-disk store to a throwaway temp dir BEFORE mcpSkillStore (via paths.ts) reads
// WORKSPACES_ROOT at import time. vi.hoisted runs above the imports.
const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcpskills-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

import { getSelectedSkills, removeWorkspace, setSelectedSkills } from "./mcpSkillStore";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("selected skills (the published set)", () => {
  it("defaults to nothing published", () => {
    expect(getSelectedSkills("never-configured")).toEqual([]);
  });

  it("round-trips a selection and dedupes while preserving order", () => {
    setSelectedSkills("ws-sel", ["check_stock", "place_order", "check_stock"]);
    expect(getSelectedSkills("ws-sel")).toEqual(["check_stock", "place_order"]);
  });

  it("returns a copy that cannot mutate the stored selection", () => {
    setSelectedSkills("ws-copy", ["a", "b"]);
    getSelectedSkills("ws-copy").push("c");
    expect(getSelectedSkills("ws-copy")).toEqual(["a", "b"]);
  });

  it("drops non-string and empty entries", () => {
    setSelectedSkills("ws-dirty", ["ok", "", null as unknown as string, 7 as unknown as string]);
    expect(getSelectedSkills("ws-dirty")).toEqual(["ok"]);
  });

  it("replaces rather than merges, so deselecting actually unpublishes", () => {
    setSelectedSkills("ws-replace", ["a", "b"]);
    setSelectedSkills("ws-replace", ["b"]);
    expect(getSelectedSkills("ws-replace")).toEqual(["b"]);
  });
});

describe("removeWorkspace", () => {
  it("clears the selection so nothing stays published after workspace deletion", () => {
    setSelectedSkills("ws-del", ["x"]);
    removeWorkspace("ws-del");
    expect(getSelectedSkills("ws-del")).toEqual([]);
  });

  it("is a no-op for a workspace that never had a selection", () => {
    expect(() => removeWorkspace("ws-never-existed")).not.toThrow();
  });
});

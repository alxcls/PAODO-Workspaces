// validatePreviewToken gates the opaque-origin preview's access to a workspace's proxy/serve
// routes (server.ts Basic-Auth bypass). The dangerous failure is authorizing a request it should
// deny — especially one workspace's token used against another workspace.

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";

// Redirect the persisted secret to a throwaway temp dir BEFORE previewToken (via paths.ts) reads
// WORKSPACES_ROOT at import time. vi.hoisted runs above the imports.
const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "previewtoken-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

import { getPreviewToken, validatePreviewToken } from "./previewToken";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("preview token", () => {
  it("validates the token derived for the same workspace", () => {
    const token = getPreviewToken("ws-a");
    expect(validatePreviewToken("ws-a", token)).toBe(true);
  });

  it("is stable across calls for a given workspace", () => {
    expect(getPreviewToken("ws-stable")).toBe(getPreviewToken("ws-stable"));
  });

  it("is distinct per workspace", () => {
    expect(getPreviewToken("ws-a")).not.toBe(getPreviewToken("ws-b"));
  });

  it("rejects one workspace's token presented for another (cross-workspace isolation)", () => {
    const tokenA = getPreviewToken("ws-a");
    expect(validatePreviewToken("ws-b", tokenA)).toBe(false);
  });

  it("rejects empty and garbage tokens", () => {
    expect(validatePreviewToken("ws-a", "")).toBe(false);
    expect(validatePreviewToken("ws-a", "not-a-real-token")).toBe(false);
  });
});

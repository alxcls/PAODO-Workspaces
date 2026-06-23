// The upload route writes caller-controlled paths into the workspace dir. Two inputs decide where
// bytes land: a ZIP entry name, and the single-file `?path=` query param. The bug class is zip-slip
// / path-traversal — an entry named "../escape.txt" (or an absolute single-file path) escaping the
// workspace and overwriting host files. E2E only uploads well-formed archives, so this guard is
// invisible there; it must be unit-pinned. These tests use a real on-disk workspace and assert the
// escaping write is both reported as a failure AND never actually lands outside the dir.

import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import JSZip from "jszip";

// Real workspace dir on disk (the route calls fs.realpath on it), with a sibling location OUTSIDE
// it where a successful zip-slip would deposit its payload.
const { ROOT, WS_DIR } = vi.hoisted(() => {
  const os = require("os"); const fs = require("fs"); const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-upload-test-"));
  const wsDir = path.join(root, "ws");
  fs.mkdirSync(wsDir);
  return { ROOT: root, WS_DIR: wsDir };
});

vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspace: (id: string) => (id === "ws" ? { id: "ws", name: "ws", dir: WS_DIR } : undefined) }),
  getVersioning: () => ({ commitResult: async () => ({ sha: "test", changed: false }) }),
}));
vi.mock("@/lib/infra/realtime/clientIp", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/infra/security/rateLimit", () => ({ checkRateLimit: () => ({ ok: true, retryAfter: 0 }) }));

import { POST } from "./route";

const ctx = { params: Promise.resolve({ id: "ws" }) };
const ESCAPE_TARGET = path.join(ROOT, "escape.txt"); // sibling of WS_DIR — outside the workspace

beforeEach(() => {
  // Clean any prior writes so each test's filesystem assertions stand alone.
  for (const p of [ESCAPE_TARGET, path.join(WS_DIR, "safe.txt")]) {
    fs.rmSync(p, { force: true });
  }
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("files/upload POST — zip-slip & path containment", () => {
  it("rejects a ZIP entry that escapes the workspace, but extracts the safe one", async () => {
    // JSZip's parser strips "../" segments from entry names, but it PRESERVES absolute paths — so
    // an absolute entry name is the real zip-slip vector here. Using ESCAPE_TARGET (a real writable
    // location outside the workspace) means a broken guard would actually plant the file there,
    // making the "never landed outside" assertion meaningful rather than masked by a perms error.
    const zip = new JSZip();
    zip.file("safe.txt", "legit");
    zip.file(ESCAPE_TARGET, "PWNED"); // absolute path outside the workspace
    const buf = await zip.generateAsync({ type: "nodebuffer" });

    const res = await POST(
      new Request("http://x/api/upload", {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: new Uint8Array(buf),
      }) as never,
      ctx,
    );

    // The escaping entry is reported, the safe one counted.
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.failures).toContain(ESCAPE_TARGET);

    // What actually matters: the payload never landed outside the workspace,
    // and the legitimate file did land inside it.
    expect(fs.existsSync(ESCAPE_TARGET)).toBe(false);
    expect(fs.readFileSync(path.join(WS_DIR, "safe.txt"), "utf8")).toBe("legit");
  });

  it("rejects a single-file upload whose ?path escapes the workspace", async () => {
    const res = await POST(
      new Request(`http://x/api/upload?path=${encodeURIComponent("../escape.txt")}`, {
        method: "POST",
        body: "PWNED",
      }) as never,
      ctx,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid path/i);
    expect(fs.existsSync(ESCAPE_TARGET)).toBe(false);
  });

  it("accepts a single-file upload that stays inside the workspace", async () => {
    const res = await POST(
      new Request(`http://x/api/upload?path=${encodeURIComponent("safe.txt")}`, {
        method: "POST",
        body: "legit",
      }) as never,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(WS_DIR, "safe.txt"), "utf8")).toBe("legit");
  });
});

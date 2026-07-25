// The upload route writes a caller-controlled path into the workspace dir. One input decides where
// bytes land: the `?path=` query param. The bug class is path traversal — a path like "../escape.txt"
// (or an absolute one) escaping the workspace and overwriting host files. E2E only uploads
// well-formed files, so this guard is invisible there; it must be unit-pinned. These tests use a real
// on-disk workspace and a sibling location OUTSIDE it where a successful escape would deposit its
// payload, so a broken guard fails the "never landed outside" assertion rather than being masked.
//
// The size limit is pinned here too. It is the difference between a clear 413 and an OOM: the handler
// streams to disk precisely so an over-limit body is refused without ever being held in memory, and
// a refused upload must leave neither a truncated file at the target path nor a stray temp file.

import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

// Real workspace dir on disk (the route calls fs.realpath on it), with a sibling location OUTSIDE
// it where a successful traversal would deposit its payload.
// LIMIT lives in here with them because vi.mock below is hoisted above any plain top-level const.
// It is small enough to exceed with a few bytes, so the over-limit paths are exercised for real
// rather than approximated by faking a Content-Length header.
const { ROOT, WS_DIR, LIMIT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-upload-test-"));
  const wsDir = path.join(root, "ws");
  fs.mkdirSync(wsDir);
  return { ROOT: root, WS_DIR: wsDir, LIMIT: 64 };
});

vi.mock("@/lib/workspace/uploadLimits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/uploadLimits")>()),
  MAX_UPLOAD_BYTES: LIMIT,
}));

const checkFreeSpace = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true, freeBytes: Infinity }));
vi.mock("@/lib/workspace/diskSpace", () => ({ checkFreeSpace }));

vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspace: (id: string) => (id === "ws" ? { id: "ws", name: "ws", dir: WS_DIR } : undefined) }),
  getVersioning: () => ({ commitResult: async () => ({ sha: "test", changed: false }) }),
}));
vi.mock("@/lib/infra/realtime/clientIp", () => ({ getClientIp: () => "1.2.3.4" }));
vi.mock("@/lib/infra/security/rateLimit", () => ({
  checkRateLimit: () => ({ ok: true, retryAfter: 0 }),
  checkRateLimitPolicy: () => ({ ok: true, retryAfter: 0 }),
}));

import { POST } from "./route";

const ctx = { params: Promise.resolve({ id: "ws" }) };
const ESCAPE_TARGET = path.join(ROOT, "escape.txt"); // sibling of WS_DIR — outside the workspace

const post = (query: string, init: RequestInit) =>
  POST(new Request(`http://x/api/upload${query}`, { method: "POST", ...init }) as never, ctx);

/** Temp files are named "<target>.<hex>.part"; any left behind is a leak. */
const strayTempFiles = () => fs.readdirSync(WS_DIR).filter((name) => name.endsWith(".part"));

beforeEach(() => {
  for (const name of fs.readdirSync(WS_DIR)) fs.rmSync(path.join(WS_DIR, name), { recursive: true, force: true });
  fs.rmSync(ESCAPE_TARGET, { force: true });
  checkFreeSpace.mockResolvedValue({ ok: true, freeBytes: Infinity });
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("files/upload POST — path containment", () => {
  it("rejects an upload whose ?path escapes the workspace via ..", async () => {
    const res = await post(`?path=${encodeURIComponent("../escape.txt")}`, { body: "PWNED" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid path/i);
    expect(fs.existsSync(ESCAPE_TARGET)).toBe(false);
  });

  it("rejects an upload whose ?path is absolute", async () => {
    const res = await post(`?path=${encodeURIComponent(ESCAPE_TARGET)}`, { body: "PWNED" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid path/i);
    expect(fs.existsSync(ESCAPE_TARGET)).toBe(false);
  });

  it("requires a path", async () => {
    const res = await post("", { body: "orphan" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/path required/i);
  });

  it("accepts an upload that stays inside the workspace, including nested dirs", async () => {
    const res = await post(`?path=${encodeURIComponent("src/deep/safe.txt")}`, { body: "legit" });

    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(WS_DIR, "src/deep/safe.txt"), "utf8")).toBe("legit");
  });
});

describe("files/upload POST — size limit", () => {
  it("refuses a body whose declared Content-Length is over the limit, and writes nothing", async () => {
    // A string body makes fetch set Content-Length, which is the path a real oversized upload takes.
    const res = await post(`?path=${encodeURIComponent("big.bin")}`, { body: "x".repeat(LIMIT + 1) });

    expect(res.status).toBe(413);
    // The message has to explain itself — the size AND the limit, not just "too large".
    expect((await res.json()).error).toMatch(/over the .* per-file upload limit/i);
    expect(fs.existsSync(path.join(WS_DIR, "big.bin"))).toBe(false);
    expect(strayTempFiles()).toEqual([]);
  });

  it("refuses an over-limit body that declares no length, leaving no partial or temp file", async () => {
    // No Content-Length (chunked), so the limit can only be caught mid-stream — and the target must
    // not be left holding the truncated prefix that was already written.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let chunk = 0; chunk < 4; chunk++) controller.enqueue(new Uint8Array(LIMIT / 2));
        controller.close();
      },
    });

    const res = await post(`?path=${encodeURIComponent("streamed.bin")}`, {
      body,
      // Node requires this to send a stream body.
      duplex: "half",
    } as RequestInit);

    expect(res.status).toBe(413);
    expect(fs.existsSync(path.join(WS_DIR, "streamed.bin"))).toBe(false);
    expect(strayTempFiles()).toEqual([]);
  });

  it("accepts a body exactly at the limit", async () => {
    const res = await post(`?path=${encodeURIComponent("exact.bin")}`, { body: "x".repeat(LIMIT) });

    expect(res.status).toBe(200);
    expect(fs.statSync(path.join(WS_DIR, "exact.bin")).size).toBe(LIMIT);
  });
});

describe("files/upload POST — disk space", () => {
  it("refuses an upload when the host is out of free space, and writes nothing", async () => {
    checkFreeSpace.mockResolvedValue({ ok: false, freeBytes: 0 });

    const res = await post(`?path=${encodeURIComponent("no-room.bin")}`, { body: "x".repeat(LIMIT) });

    expect(res.status).toBe(507);
    expect((await res.json()).error).toMatch(/not enough free disk space/i);
    expect(fs.existsSync(path.join(WS_DIR, "no-room.bin"))).toBe(false);
    expect(strayTempFiles()).toEqual([]);
  });
});

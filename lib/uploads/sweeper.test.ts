// The sweeper's whole job is telling a genuinely orphaned temp file apart from one that just
// hasn't finished yet, and from anything that isn't a temp file at all. These tests build a real
// on-disk tree — fresh .part, stale .part, a non-.part file, and a stale .part nested inside .git —
// and assert the sweep removes only the one file it's actually supposed to.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";

const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-sweep-test-"));
  return { ROOT: root };
});

vi.mock("../infra/paths", () => ({ WORKSPACES_ROOT: ROOT }));

import { _tick } from "./sweeper";

const HOUR = 60 * 60_000;

const write = (relPath: string, ageMs?: number) => {
  const full = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "data");
  if (ageMs !== undefined) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(full, past, past);
  }
};

beforeEach(() => {
  for (const name of fs.readdirSync(ROOT)) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("upload sweeper", () => {
  it("removes a stale orphaned .part file", async () => {
    write("ws/src/big.bin.a1b2c3d4e5f6.part", 3 * HOUR);

    await _tick();

    expect(fs.existsSync(path.join(ROOT, "ws/src/big.bin.a1b2c3d4e5f6.part"))).toBe(false);
  });

  it("leaves a fresh .part file alone — it may still be an in-flight upload", async () => {
    write("ws/big.bin.a1b2c3d4e5f6.part", 5 * 60_000);

    await _tick();

    expect(fs.existsSync(path.join(ROOT, "ws/big.bin.a1b2c3d4e5f6.part"))).toBe(true);
  });

  it("never touches a real (non-.part) file, however old", async () => {
    write("ws/notes.md", 3 * HOUR);

    await _tick();

    expect(fs.existsSync(path.join(ROOT, "ws/notes.md"))).toBe(true);
  });

  it("does not descend into .git even if it holds a stale-looking .part name", async () => {
    write("ws/.git/objects/whatever.a1b2c3d4e5f6.part", 3 * HOUR);

    await _tick();

    expect(fs.existsSync(path.join(ROOT, "ws/.git/objects/whatever.a1b2c3d4e5f6.part"))).toBe(true);
  });
});

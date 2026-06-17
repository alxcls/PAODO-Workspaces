// The workspace file-content API route must serve files inside a workspace but
// reject path-traversal attempts to read host files outside it.

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";
import path from "path";

// Build a real on-disk fixture BEFORE the module mock is hoisted:
//
//   <root>/
//     secret.txt          <- OUTSIDE the workspace (host secret)
//     ws/                 <- the workspace dir
//       hello.txt         <- a legitimate file
//       escape            <- symlink pointing at ../secret.txt
//
// This mirrors the real attack: an agent inside its container plants a symlink
// in its own workspace, then a host-side HTTP request tries to read it.
const { WS_DIR, ESCAPE } = vi.hoisted(() => {
  const os = require("os"); const fs = require("fs"); const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-content-test-"));
  const wsDir = path.join(root, "ws");
  fs.mkdirSync(wsDir);
  fs.writeFileSync(path.join(wsDir, "hello.txt"), "hi there");
  const secret = path.join(root, "secret.txt");
  fs.writeFileSync(secret, "TOPSECRET");
  const escape = path.join(wsDir, "escape");
  fs.symlinkSync(secret, escape);
  return { ROOT: root, WS_DIR: wsDir, ESCAPE: escape };
});

vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspace: (id: string) => (id === "ws" ? { id: "ws", dir: WS_DIR } : undefined) }),
  getContainers: () => ({}),
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({ id: "ws" }) };
const getFile = (p: string) =>
  GET(new Request(`http://x/api/files/content?path=${encodeURIComponent(p)}`), ctx);

afterAll(() => fs.rmSync(path.dirname(WS_DIR), { recursive: true, force: true }));

describe("files/content GET — workspace containment", () => {
  it("serves a file that lives inside the workspace", async () => {
    const res = await getFile(path.join(WS_DIR, "hello.txt"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "text", content: "hi there" });
  });

  // THE test that matters: a symlink inside the workspace pointing outside it
  // must NOT be followed. This is the cross-workspace / host-file boundary.
  it("refuses to follow a symlink that escapes the workspace", async () => {
    const res = await getFile(ESCAPE);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/outside workspace/i);
  });

  // Use a real file we created OUTSIDE the workspace, so the rejection can only
  // come from the containment check — not from the file happening to not exist.
  it("refuses an absolute path pointing outside the workspace", async () => {
    const outside = path.join(path.dirname(WS_DIR), "secret.txt");
    const res = await getFile(outside);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/outside workspace/i);
  });
});

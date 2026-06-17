// The serve route reconstructs a filesystem path from URL segments and streams the file to an
// iframe. workspaceContainment.test.ts proves the guard itself; this file proves THIS route wires
// it and maps a containment failure to a quiet 404 (it must not leak a host file, nor reveal via a
// distinct status that the path resolved outside the workspace). Pinned because E2E only previews
// legitimate files and would never exercise the symlink-escape branch.

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";
import path from "path";

// Same fixture shape as the content-route test: a workspace with a legit file and a symlink that
// escapes to a host secret outside it.
const { WS_DIR } = vi.hoisted(() => {
  const os = require("os"); const fs = require("fs"); const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-serve-test-"));
  const wsDir = path.join(root, "ws");
  fs.mkdirSync(wsDir);
  fs.writeFileSync(path.join(wsDir, "page.html"), "<h1>hi</h1>");
  fs.writeFileSync(path.join(root, "secret.txt"), "TOPSECRET");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(wsDir, "escape"));
  return { WS_DIR: wsDir };
});

vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspace: (id: string) => (id === "ws" ? { id: "ws", dir: WS_DIR } : undefined) }),
}));

import { GET } from "./route";

// The route builds its path from URL segments, so the test supplies the absolute path's segments.
function get(absPath: string): Promise<Response> {
  const filepath = absPath.split("/").filter(Boolean);
  return GET(new Request("http://x/serve"), { params: Promise.resolve({ id: "ws", filepath }) });
}

afterAll(() => fs.rmSync(path.dirname(WS_DIR), { recursive: true, force: true }));

describe("serve GET — workspace containment", () => {
  it("serves a file that lives inside the workspace", async () => {
    const res = await get(path.join(WS_DIR, "page.html"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>hi</h1>");
  });

  it("404s (does not leak) a symlink that escapes the workspace", async () => {
    const res = await get(path.join(WS_DIR, "escape"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("TOPSECRET");
  });

  it("404s for an unknown workspace", async () => {
    const res = await GET(new Request("http://x/serve"), {
      params: Promise.resolve({ id: "nope", filepath: ["page.html"] }),
    });
    expect(res.status).toBe(404);
  });
});

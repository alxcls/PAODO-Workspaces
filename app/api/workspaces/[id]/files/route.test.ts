// The tree route's transport half: which query parameters it reads, and what a path it cannot serve
// answers with. The rules themselves are lib/operations/files/listing.ts and are tested there.
import { describe, expect, it, vi, afterAll } from "vitest";
import fs from "fs";
import path from "path";

const { WS_DIR } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-tree-test-"));
  const wsDir = path.join(root, "ws");
  fs.mkdirSync(path.join(wsDir, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, "AGENTS.md"), "read me\n");
  fs.writeFileSync(path.join(wsDir, "src", "main.ts"), "main\n");
  fs.writeFileSync(path.join(wsDir, "src", "lib", "util.ts"), "util\n");
  return { WS_DIR: wsDir };
});

vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspace: (id: string) => (id === "ws" ? { id: "ws", name: "ws", dir: WS_DIR } : undefined) }),
}));

import { GET } from "./route";

const ctx = { params: Promise.resolve({ id: "ws" }) };

/** The tree route as a client actually calls it: a query string, and paths relative to the workspace. */
const list = (query = "") => GET(new Request(`http://x/api/workspaces/ws/files${query}`), ctx);

const names = (nodes: Array<{ path: string; children?: unknown }>): string[] =>
  nodes.flatMap((node) => [node.path, ...names((node.children ?? []) as typeof nodes)]).sort();

afterAll(() => fs.rmSync(path.dirname(WS_DIR), { recursive: true, force: true }));

describe("files tree GET", () => {
  it("lists the workspace root when no path is named", async () => {
    const res = await list("?depth=full");
    expect(res.status).toBe(200);
    expect(names((await res.json()).tree)).toEqual(["AGENTS.md", "src", "src/lib", "src/lib/util.ts", "src/main.ts"]);
  });

  it("scopes the listing to ?path=, keeping every entry named from the workspace root", async () => {
    const res = await list("?depth=full&path=src");
    expect(res.status).toBe(200);
    expect(names((await res.json()).tree)).toEqual(["src/lib", "src/lib/util.ts", "src/main.ts"]);
  });

  // What a client that navigates asks for: the top of the tree, then the same call again naming one of
  // the directories it just learned about. `src` comes back as a directory with nothing under it, which
  // is the caller's cue to ask about it rather than a claim that it is empty.
  it("descends only as many levels as a numeric ?depth= asks for", async () => {
    const res = await list("?depth=1");
    expect(res.status).toBe(200);
    expect(names((await res.json()).tree)).toEqual(["AGENTS.md", "src"]);
  });

  it("counts a numeric ?depth= from the directory listed, not from the workspace root", async () => {
    const res = await list("?depth=1&path=src");
    expect(res.status).toBe(200);
    expect(names((await res.json()).tree)).toEqual(["src/lib", "src/main.ts"]);
  });

  // Rounding a depth it cannot read to the panel's default would serve a different tree than the one
  // asked for, and nothing in a listing says how deep it went.
  it('answers INVALID_REQUEST for a depth that is neither a positive integer nor "full"', async () => {
    for (const depth of ["0", "-1", "1.5", "deep", ""]) {
      const res = await list(`?depth=${depth}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST", details: { field: "depth" } });
    }
  });

  // Opt-in, and only on the exact value: a listing that measured whenever the parameter merely appeared
  // would have the panel paying a read per file the first time anyone appended `&measure=0`.
  it("measures only when ?measure=1 asks it to", async () => {
    const plain = (await (await list("?depth=full")).json()).tree;
    expect(names(plain)).toContain("AGENTS.md");
    expect(plain.find((node: { path: string }) => node.path === "AGENTS.md")).not.toHaveProperty("lines");

    for (const query of ["?depth=full&measure=0", "?depth=full&measure=true", "?depth=full&measure="]) {
      const tree = (await (await list(query)).json()).tree;
      expect(tree.find((node: { path: string }) => node.path === "AGENTS.md")).not.toHaveProperty("lines");
    }

    const measured = (await (await list("?depth=full&measure=1")).json()).tree;
    expect(measured.find((node: { path: string }) => node.path === "AGENTS.md")).toMatchObject({ lines: 1 });
  });

  // A path a caller mistyped has to be distinguishable from a directory that happens to be empty:
  // both would otherwise be `{ tree: [] }` with a 200.
  it("answers NOT_FOUND for a path that is not there", async () => {
    const res = await list("?path=src/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND", error: "src/nope does not exist" });
  });

  it("answers INVALID_REQUEST for a path the caller is not allowed to say", async () => {
    const res = await list(`?path=${encodeURIComponent("../ws")}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });
});

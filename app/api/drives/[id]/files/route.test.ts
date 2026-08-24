// The drive tree route's transport half. The query parameters and the rules behind them are shared
// with the workspace route (lib/api/fileTreeRoutes.ts, lib/operations/files/listing.ts) and tested
// there; what is asserted here is that a drive is actually reachable through them — this route used to
// call buildTree directly and ignore every one of them — and that an unknown drive is a 404 rather
// than a listing of a directory that does not exist.
import { describe, expect, it, vi, afterAll } from "vitest";
import fs from "fs";

const { DRIVES_DIR } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drive-tree-test-"));
  fs.mkdirSync(path.join(root, "d1", "logos", "svg"), { recursive: true });
  fs.writeFileSync(path.join(root, "d1", "README.md"), "shared\n");
  fs.writeFileSync(path.join(root, "d1", "logos", "brand.txt"), "brand\n");
  fs.writeFileSync(path.join(root, "d1", "logos", "svg", "mark.svg"), "<svg/>\n");
  return { DRIVES_DIR: root };
});

vi.mock("@/lib/drives/store", () => ({
  getDrive: (id: string) => (id === "d1" ? { id: "d1", name: "shared", createdAt: "" } : undefined),
  driveContentDir: (id: string) => `${DRIVES_DIR}/${id}`,
}));

import { GET } from "./route";

const list = (query = "", id = "d1") =>
  GET(new Request(`http://x/api/drives/${id}/files${query}`), { params: Promise.resolve({ id }) });

const names = (nodes: Array<{ path: string; children?: unknown }>): string[] =>
  nodes.flatMap((node) => [node.path, ...names((node.children ?? []) as typeof nodes)]).sort();

afterAll(() => fs.rmSync(DRIVES_DIR, { recursive: true, force: true }));

describe("drive files tree GET", () => {
  it("lists the drive root when no path is named", async () => {
    const res = await list("?depth=full");
    expect(res.status).toBe(200);
    expect(names((await res.json()).tree)).toEqual([
      "README.md",
      "logos",
      "logos/brand.txt",
      "logos/svg",
      "logos/svg/mark.svg",
    ]);
  });

  // The parameter the panel never sends and `drive file ls` is built on: one level, then the same call
  // again naming a directory it just learned about.
  it("scopes to ?path= and descends only as far as ?depth= asks, keeping paths named from the root", async () => {
    expect(names((await (await list("?depth=1")).json()).tree)).toEqual(["README.md", "logos"]);
    expect(names((await (await list("?depth=1&path=logos")).json()).tree)).toEqual(["logos/brand.txt", "logos/svg"]);
  });

  it("measures and counts only when asked, so the panel pays for neither", async () => {
    const rootOf = (tree: Array<{ path: string }>, at: string) => tree.find((node) => node.path === at)!;

    const plain = (await (await list("?depth=1")).json()).tree;
    expect(rootOf(plain, "README.md")).not.toHaveProperty("lines");
    expect(rootOf(plain, "logos")).not.toHaveProperty("files");

    const asked = (await (await list("?depth=1&measure=1&count=1")).json()).tree;
    expect(rootOf(asked, "README.md")).toMatchObject({ lines: 1 });
    expect(rootOf(asked, "logos")).toMatchObject({ files: 2 });
  });

  it("answers INVALID_REQUEST for a depth it cannot read, rather than serving a different tree", async () => {
    const res = await list("?depth=0");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST", details: { field: "depth" } });
  });

  // ?limit= bounds breadth the way ?depth= bounds depth. `truncated` is the whole point of it: a capped
  // listing that did not say so is a prefix presented as a whole directory.
  it("caps entries at ?limit= and says truncated only when the cap actually bit", async () => {
    const whole = await (await list("?depth=1")).json();
    expect(whole.tree).toHaveLength(2);
    expect(whole).not.toHaveProperty("truncated");

    const capped = await (await list("?depth=1&limit=1")).json();
    expect(capped.tree).toHaveLength(1);
    expect(capped.truncated).toBe(true);

    // At the cap, not past it — so a directory that exactly fits is never reported as cut.
    expect(await (await list("?depth=1&limit=2")).json()).not.toHaveProperty("truncated");
  });

  it("answers INVALID_REQUEST for a limit it cannot read", async () => {
    for (const limit of ["0", "-1", "1.5", "lots", ""]) {
      const res = await list(`?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST", details: { field: "limit" } });
    }
  });

  // Both halves of "that is not a path": a path inside the drive that is not there, and one that
  // reaches outside it.
  it("answers NOT_FOUND for a missing path and INVALID_REQUEST for one that escapes the drive", async () => {
    expect((await list("?path=logos/nope")).status).toBe(404);
    expect((await list(`?path=${encodeURIComponent("../d1")}`)).status).toBe(400);
  });

  it("answers NOT_FOUND for a drive that does not exist", async () => {
    const res = await list("", "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

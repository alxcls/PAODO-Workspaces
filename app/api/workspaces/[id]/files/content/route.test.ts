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

// A spy, so the batch tests can pin how many snapshots a multi-item move actually costs.
const { commitResult } = vi.hoisted(() => ({
  commitResult: vi.fn(
    async (_workspaceId: string, _dir: string, _label: string) => ({ sha: "test", changed: true }),
  ),
}));

vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspace: (id: string) => (id === "ws" ? { id: "ws", name: "ws", dir: WS_DIR } : undefined) }),
  getContainers: () => ({}),
  getVersioning: () => ({ commitResult }),
}));

import { GET, PUT, PATCH } from "./route";
import { buildTree } from "@/lib/workspace/fileTree";

const ctx = { params: Promise.resolve({ id: "ws" }) };
const getFile = (p: string) =>
  GET(new Request(`http://x/api/files/content?path=${encodeURIComponent(p)}`), ctx);

const patchMove = (body: unknown) =>
  PATCH(new Request("http://x/api/files/content", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), ctx);

const putFile = (filePath: string, content: string) =>
  PUT(new Request("http://x/api/files/content", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: filePath, content }),
  }), ctx);

/** The path the browser actually holds for a top-level entry: what buildTree serves. */
const treePathOf = async (name: string) =>
  (await buildTree(WS_DIR)).find((n) => n.name === name)!.path;

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

describe("files/content PUT — save", () => {
  it("overwrites an existing file without leaving trailing content", async () => {
    const filePath = path.join(WS_DIR, "edit-me.txt");
    fs.writeFileSync(filePath, "a much longer original value");

    const res = await putFile(filePath, "short");

    expect(res.status).toBe(200);
    expect(fs.readFileSync(filePath, "utf8")).toBe("short");
  });
});

describe("files/content PATCH — move", () => {
  it("moves a file into a folder", async () => {
    const source = path.join(WS_DIR, "move-me.txt");
    const destinationDirectory = path.join(WS_DIR, "archive");
    fs.writeFileSync(source, "move me");
    fs.mkdirSync(destinationDirectory);

    const res = await PATCH(new Request("http://x/api/files/content", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaths: [source], destinationDirectory }),
    }), ctx);

    expect(res.status).toBe(200);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(destinationDirectory, "move-me.txt"), "utf8")).toBe("move me");
  });

  it("does not recreate the old path when a save arrives after a move", async () => {
    const source = path.join(WS_DIR, "move-then-save.txt");
    const destinationDirectory = path.join(WS_DIR, "moved-before-save");
    const destination = path.join(destinationDirectory, path.basename(source));
    fs.writeFileSync(source, "saved before move");
    fs.mkdirSync(destinationDirectory);

    expect((await patchMove({ sourcePaths: [source], destinationDirectory })).status).toBe(200);
    const saveRes = await putFile(source, "late editor draft");

    expect(saveRes.status).toBe(409);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(destination, "utf8")).toBe("saved before move");
  });

  it("moves a folder into another folder without merging", async () => {
    const source = path.join(WS_DIR, "move-folder");
    const destinationDirectory = path.join(WS_DIR, "folder-archive");
    fs.mkdirSync(source);
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(source, "nested.txt"), "nested");

    const res = await patchMove({ sourcePaths: [source], destinationDirectory });

    expect(res.status).toBe(200);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(destinationDirectory, "move-folder", "nested.txt"), "utf8"))
      .toBe("nested");
  });

  it("rejects moving a folder into one of its descendants", async () => {
    const source = path.join(WS_DIR, "parent");
    const descendant = path.join(source, "child");
    fs.mkdirSync(descendant, { recursive: true });

    const res = await PATCH(new Request("http://x/api/files/content", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaths: [source], destinationDirectory: descendant }),
    }), ctx);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/into itself/i);
    expect(fs.existsSync(descendant)).toBe(true);
  });

  it("returns a conflict without overwriting an existing item", async () => {
    const sourceDirectory = path.join(WS_DIR, "from");
    const destinationDirectory = path.join(WS_DIR, "to");
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(destinationDirectory);
    const source = path.join(sourceDirectory, "same.txt");
    const destination = path.join(destinationDirectory, "same.txt");
    fs.writeFileSync(source, "source");
    fs.writeFileSync(destination, "destination");

    const res = await PATCH(new Request("http://x/api/files/content", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaths: [source], destinationDirectory }),
    }), ctx);

    expect(res.status).toBe(409);
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    expect(fs.readFileSync(destination, "utf8")).toBe("destination");
  });

  // The mkdir reservation carries this case alone: rename(2) replaces an empty directory happily,
  // so without the reservation an empty same-named folder is silently clobbered and the 409 never
  // fires. A non-empty one is caught by rename's own ENOTEMPTY, which is why it can't pin this.
  it("returns a conflict rather than replacing an empty same-named folder", async () => {
    const sourceDirectory = path.join(WS_DIR, "empty-from");
    const destinationDirectory = path.join(WS_DIR, "empty-to");
    const source = path.join(sourceDirectory, "dup");
    const destination = path.join(destinationDirectory, "dup");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(source, "mine.txt"), "mine");

    const res = await patchMove({ sourcePaths: [source], destinationDirectory });

    expect(res.status).toBe(409);
    expect(fs.readFileSync(path.join(source, "mine.txt"), "utf8")).toBe("mine");
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  // Folders take the mkdir-reserve-then-rename path rather than the files' link-then-unlink one,
  // so a same-named folder at the destination has to be rejected outright: merging the two trees
  // would be a silent, unrecoverable mix of the user's files.
  it("returns a conflict without merging into a same-named folder", async () => {
    const sourceDirectory = path.join(WS_DIR, "merge-from");
    const destinationDirectory = path.join(WS_DIR, "merge-to");
    const source = path.join(sourceDirectory, "dup");
    const destination = path.join(destinationDirectory, "dup");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(source, "mine.txt"), "mine");
    fs.writeFileSync(path.join(destination, "theirs.txt"), "theirs");

    const res = await patchMove({ sourcePaths: [source], destinationDirectory });

    expect(res.status).toBe(409);
    expect(fs.readFileSync(path.join(source, "mine.txt"), "utf8")).toBe("mine");
    expect(fs.readFileSync(path.join(destination, "theirs.txt"), "utf8")).toBe("theirs");
    expect(fs.existsSync(path.join(destination, "mine.txt"))).toBe(false);
  });

  it("returns a conflict when a file collides with a same-named folder", async () => {
    const destinationDirectory = path.join(WS_DIR, "clash-to");
    fs.mkdirSync(path.join(destinationDirectory, "clash"), { recursive: true });
    const source = path.join(WS_DIR, "clash");
    fs.writeFileSync(source, "filedata");

    const res = await patchMove({ sourcePaths: [source], destinationDirectory });

    expect(res.status).toBe(409);
    expect(fs.readFileSync(source, "utf8")).toBe("filedata");
    expect(fs.statSync(path.join(destinationDirectory, "clash")).isDirectory()).toBe(true);
  });

  it("rejects a destination outside the workspace", async () => {
    const source = path.join(WS_DIR, "stay-put.txt");
    fs.writeFileSync(source, "safe");

    const res = await PATCH(new Request("http://x/api/files/content", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourcePaths: [source], destinationDirectory: path.dirname(WS_DIR) }),
    }), ctx);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/outside workspace/i);
    expect(fs.readFileSync(source, "utf8")).toBe("safe");
  });

  // The browser can only act on a path it can find in the tree it was served. Returning the
  // realpath instead silently breaks selection and expansion state wherever the workspace dir
  // contains a symlink — which it does on macOS, where os.tmpdir() sits under /var → /private/var.
  it("returns the new path in the same space the file tree serves", async () => {
    const destinationDirectory = path.join(WS_DIR, "inbox");
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(WS_DIR, "tracked.txt"), "x");

    const res = await patchMove({
      sourcePaths: [await treePathOf("tracked.txt")],
      destinationDirectory,
    });

    expect(res.status).toBe(200);
    const inbox = (await buildTree(WS_DIR)).find((n) => n.name === "inbox")!;
    expect(inbox.children!.map((c) => c.path)).toContain((await res.json()).results[0].path);
  });

  it("reports a move into the folder the item is already in as unchanged", async () => {
    fs.writeFileSync(path.join(WS_DIR, "already-here.txt"), "x");
    const sourcePath = await treePathOf("already-here.txt");

    const res = await patchMove({ sourcePaths: [sourcePath], destinationDirectory: WS_DIR });

    expect(res.status).toBe(200);
    // The client keys its no-op check off `unchanged`, and echoes `path` back into its own state.
    expect(await res.json()).toEqual({
      ok: true,
      results: [{ sourcePath, path: sourcePath, unchanged: true }],
    });
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  // A symlink that escapes the workspace never reaches the symlink rule — containment resolves it
  // to the host file and rejects it there. The host file must be left untouched either way.
  it("refuses to move a symlink that escapes the workspace", async () => {
    const destinationDirectory = path.join(WS_DIR, "sym-dest");
    fs.mkdirSync(destinationDirectory);

    const res = await patchMove({ sourcePaths: [ESCAPE], destinationDirectory });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/outside workspace/i);
    expect(fs.lstatSync(ESCAPE).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(path.dirname(WS_DIR), "secret.txt"), "utf8")).toBe("TOPSECRET");
  });

  // A symlink pointing *inside* the workspace passes containment, so it is the case the dedicated
  // symlink rule exists for: moving it by its resolved target would silently move hello.txt.
  it("refuses to move a symlink that stays inside the workspace", async () => {
    const link = path.join(WS_DIR, "hello-link");
    const destinationDirectory = path.join(WS_DIR, "link-dest");
    fs.symlinkSync(path.join(WS_DIR, "hello.txt"), link);
    fs.mkdirSync(destinationDirectory);

    const res = await patchMove({ sourcePaths: [link], destinationDirectory });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/symbolic link/i);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // The link's target stayed where it was rather than being moved in its place.
    expect(fs.existsSync(path.join(WS_DIR, "hello.txt"))).toBe(true);
    expect(fs.readdirSync(destinationDirectory)).toEqual([]);
  });

  it("refuses to move the workspace root", async () => {
    const res = await patchMove({ sourcePaths: [WS_DIR], destinationDirectory: WS_DIR });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/workspace root/i);
  });

  it("rejects a malformed body without throwing", async () => {
    expect((await patchMove("{not json")).status).toBe(400);
    expect((await patchMove(null)).status).toBe(400);
    expect((await patchMove({ destinationDirectory: WS_DIR })).status).toBe(400);
  });

  it("rejects an invalid destination type instead of treating it as the workspace root", async () => {
    const source = path.join(WS_DIR, "typed-destination.txt");
    fs.writeFileSync(source, "stay");

    const res = await patchMove({ sourcePaths: [source], destinationDirectory: false });

    expect(res.status).toBe(400);
    expect(fs.readFileSync(source, "utf8")).toBe("stay");
  });

  it("rejects a batch with no items", async () => {
    expect((await patchMove({ sourcePaths: [], destinationDirectory: WS_DIR })).status).toBe(400);
    expect((await patchMove({ sourcePaths: "not-an-array" })).status).toBe(400);
    expect((await patchMove({ sourcePaths: [""] })).status).toBe(400);
  });

  it("moves every item of a batch in one request", async () => {
    const destinationDirectory = path.join(WS_DIR, "batch-dest");
    fs.mkdirSync(destinationDirectory);
    const names = ["one.txt", "two.txt", "three.txt"];
    for (const n of names) fs.writeFileSync(path.join(WS_DIR, `batch-${n}`), n);
    const sourcePaths = names.map((n) => path.join(WS_DIR, `batch-${n}`));

    const res = await patchMove({ sourcePaths, destinationDirectory });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.results.map((r: { sourcePath: string }) => r.sourcePath)).toEqual(sourcePaths);
    for (const n of names) {
      expect(fs.readFileSync(path.join(destinationDirectory, `batch-${n}`), "utf8")).toBe(n);
      expect(fs.existsSync(path.join(WS_DIR, `batch-${n}`))).toBe(false);
    }
  });

  // The reason the batch endpoint exists: a request-and-snapshot per item is what made large
  // selections crawl, so a batch must cost exactly one snapshot however many items it carries.
  it("takes a single snapshot for the whole batch", async () => {
    const destinationDirectory = path.join(WS_DIR, "snap-dest");
    fs.mkdirSync(destinationDirectory);
    const sourcePaths = ["a", "b", "c", "d"].map((n) => path.join(WS_DIR, `snap-${n}.txt`));
    for (const p of sourcePaths) fs.writeFileSync(p, "x");

    commitResult.mockClear();
    const res = await patchMove({ sourcePaths, destinationDirectory });

    expect(res.status).toBe(200);
    expect(commitResult).toHaveBeenCalledTimes(1);
    expect(commitResult.mock.calls[0][2]).toMatch(/moved 4 items to snap-dest/);
  });

  it("does not snapshot a batch that changed nothing", async () => {
    fs.writeFileSync(path.join(WS_DIR, "noop.txt"), "x");

    commitResult.mockClear();
    const res = await patchMove({
      sourcePaths: [await treePathOf("noop.txt")],
      destinationDirectory: WS_DIR,
    });

    expect(res.status).toBe(200);
    expect(commitResult).not.toHaveBeenCalled();
  });

  it("stops at the first failure and reports the items that already moved", async () => {
    const destinationDirectory = path.join(WS_DIR, "partial-dest");
    fs.mkdirSync(destinationDirectory);
    const first = path.join(WS_DIR, "partial-first.txt");
    const blocked = path.join(WS_DIR, "partial-blocked.txt");
    const never = path.join(WS_DIR, "partial-never.txt");
    for (const p of [first, blocked, never]) fs.writeFileSync(p, "x");
    // Pre-occupy the middle item's destination so it, and only it, conflicts.
    fs.writeFileSync(path.join(destinationDirectory, "partial-blocked.txt"), "occupied");

    const res = await patchMove({ sourcePaths: [first, blocked, never], destinationDirectory });

    // Some of the work is real, so the batch is a 200 that carries what landed and what stopped it.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/already exists/i);
    expect(body.failedSourcePath).toBe(blocked);
    expect(body.results.map((r: { sourcePath: string }) => r.sourcePath)).toEqual([first]);

    expect(fs.existsSync(path.join(destinationDirectory, "partial-first.txt"))).toBe(true);
    expect(fs.readFileSync(blocked, "utf8")).toBe("x");
    expect(fs.readFileSync(path.join(destinationDirectory, "partial-blocked.txt"), "utf8"))
      .toBe("occupied");
    // The item after the failure was never attempted and must be exactly where it was.
    expect(fs.readFileSync(never, "utf8")).toBe("x");
  });

  // An item already in the destination is a no-op, not a failure — it must not stop the batch.
  it("keeps going past an unchanged item", async () => {
    const destinationDirectory = path.join(WS_DIR, "mixed-dest");
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(destinationDirectory, "settled.txt"), "already");
    const mover = path.join(WS_DIR, "mixed-mover.txt");
    fs.writeFileSync(mover, "moves");
    const settled = (await buildTree(WS_DIR))
      .find((n) => n.name === "mixed-dest")!.children!
      .find((n) => n.name === "settled.txt")!.path;

    const res = await patchMove({ sourcePaths: [settled, mover], destinationDirectory });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.results).toEqual([
      { sourcePath: settled, path: settled, unchanged: true },
      { sourcePath: mover, path: path.join(destinationDirectory, "mixed-mover.txt"), unchanged: false },
    ]);
    expect(fs.readFileSync(path.join(destinationDirectory, "mixed-mover.txt"), "utf8")).toBe("moves");
  });

  it("does not replace an existing directory", async () => {
    const sourceParent = path.join(WS_DIR, "dir-from");
    const destinationParent = path.join(WS_DIR, "dir-to");
    const source = path.join(sourceParent, "same-dir");
    const destination = path.join(destinationParent, "same-dir");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(source, "source.txt"), "source");
    fs.writeFileSync(path.join(destination, "destination.txt"), "destination");

    const res = await patchMove({ sourcePaths: [source], destinationDirectory: destinationParent });

    expect(res.status).toBe(409);
    expect(fs.readFileSync(path.join(source, "source.txt"), "utf8")).toBe("source");
    expect(fs.readFileSync(path.join(destination, "destination.txt"), "utf8"))
      .toBe("destination");
  });
});

// The workspace file-content API route must serve files inside a workspace but reject every attempt to
// name a host file outside it.
//
// Requests speak workspace-relative paths (lib/files/relpath.ts) — "hello.txt", never
// "/tmp/.../ws/hello.txt". The fixtures below still build absolute paths, because that is what fs
// needs; `abs()` marks each crossing, and anything passed to a request is deliberately relative. A
// test that names an absolute path in a request is asserting the refusal, not setting up a read.

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
const { WS_DIR } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-content-test-"));
  const wsDir = path.join(root, "ws");
  fs.mkdirSync(wsDir);
  fs.writeFileSync(path.join(wsDir, "hello.txt"), "hi there");
  const secret = path.join(root, "secret.txt");
  fs.writeFileSync(secret, "TOPSECRET");
  fs.symlinkSync(secret, path.join(wsDir, "escape"));
  return { ROOT: root, WS_DIR: wsDir };
});

// A spy, so the batch tests can pin how many snapshots a multi-item move actually costs.
const { commitResult } = vi.hoisted(() => ({
  commitResult: vi.fn(async (_workspaceId: string, _dir: string, _label: string) => ({ sha: "test", changed: true })),
}));

vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspace: (id: string) => (id === "ws" ? { id: "ws", name: "ws", dir: WS_DIR } : undefined) }),
  getContainers: () => ({}),
  getVersioning: () => ({ commitResult }),
}));

import { GET, PUT, PATCH, DELETE } from "./route";
import { buildTree } from "@/lib/files/tree";

const ctx = { params: Promise.resolve({ id: "ws" }) };

/** The host path for a workspace-relative one. Fixtures only — never an argument to a request. */
const abs = (relPath: string) => path.join(WS_DIR, relPath);

const getFile = (p: string) => GET(new Request(`http://x/api/files/content?path=${encodeURIComponent(p)}`), ctx);

const patchMove = (body: unknown) =>
  PATCH(
    new Request("http://x/api/files/content", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx,
  );

const putFile = (filePath: string, content: string) =>
  PUT(
    new Request("http://x/api/files/content", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: filePath, content }),
    }),
    ctx,
  );

/** The path the browser actually holds for a top-level entry: what buildTree serves. */
const treePathOf = async (name: string) => (await buildTree(WS_DIR)).find((n) => n.name === name)!.path;

afterAll(() => fs.rmSync(path.dirname(WS_DIR), { recursive: true, force: true }));

describe("files/content GET — workspace containment", () => {
  it("serves a file that lives inside the workspace", async () => {
    const res = await getFile("hello.txt");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "text", content: "hi there" });
  });

  it("serves a file the tree named, without the client ever seeing the host directory", async () => {
    const treePath = await treePathOf("hello.txt");
    expect(treePath).toBe("hello.txt");
    expect((await getFile(treePath)).status).toBe(200);
  });

  // THE test that matters: a symlink inside the workspace pointing outside it must NOT be followed.
  // This is the cross-workspace / host-file boundary, and it is the one case a lexical path check
  // cannot see — "escape" is a perfectly ordinary relative path.
  it("refuses to follow a symlink that escapes the workspace", async () => {
    const res = await getFile("escape");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/outside the workspace/i);
  });

  // Use a real file we created OUTSIDE the workspace, so a passing test can only mean the path was
  // refused — not that the file happened not to exist.
  it("refuses an absolute host path outright, whatever it points at", async () => {
    const res = await getFile(path.join(path.dirname(WS_DIR), "secret.txt"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must be relative/i);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("refuses a .. traversal", async () => {
    const res = await getFile("../secret.txt");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/escapes the workspace/i);
  });

  // An agent that has been editing /workspace/src/main.ts through its own tools will reach for the
  // same string here. Naming the right form is what stops it retrying the same mistake.
  it("names the correct form when given the container's own mount path", async () => {
    const res = await getFile("/workspace/hello.txt");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/relative to the workspace root.*use "hello\.txt"/i);
  });

  it("reports a missing file as not found rather than as a bad request", async () => {
    const res = await getFile("nope.txt");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });
});

// The transport half of a line window: which query parameters reach the rule, and that the raw body a
// CLI pipes to stdout is the window rather than the file. The line arithmetic itself is pinned in
// lib/operations/files/content.test.ts.
describe("files/content GET — a window of lines", () => {
  const window = (query: string) => GET(new Request(`http://x/api/files/content?${query}`), ctx);

  it("serves only the lines asked for, raw, so a caller can read part of a file it cannot hold", async () => {
    fs.writeFileSync(abs("long.txt"), "one\ntwo\nthree\nfour\n");

    const res = await window("path=long.txt&raw=1&offset=1&limit=2");

    expect(res.status).toBe(200);
    // The body is the window's own bytes, not the file's with the rest ignored — this is what the CLI
    // pipes to stdout, and what the whole point of asking for a window is not to have transferred.
    expect(await res.text()).toBe("two\nthree\n");
  });

  it("serves the window through the JSON shape too, so both clients read one file the same way", async () => {
    fs.writeFileSync(abs("long-json.txt"), "one\ntwo\nthree\nfour\n");
    expect(await (await window("path=long-json.txt&offset=2")).json()).toEqual({
      type: "text",
      content: "three\nfour\n",
    });
  });

  it("serves the whole file when neither parameter is named — the file panel's own request", async () => {
    fs.writeFileSync(abs("whole.txt"), "one\ntwo\n");
    expect(await (await window("path=whole.txt")).json()).toEqual({ type: "text", content: "one\ntwo\n" });
  });

  it("refuses a window a caller cannot ask for, naming the parameter that was wrong", async () => {
    fs.writeFileSync(abs("bad-window.txt"), "one\ntwo\n");
    for (const [query, field] of [
      ["offset=abc", "offset"],
      ["offset=-1", "offset"],
      ["limit=0", "limit"],
      ["limit=", "limit"],
    ]) {
      const res = await window(`path=bad-window.txt&${query}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST", details: { field } });
    }
  });

  // Serving the whole thing instead would be the expensive way to learn the file has no lines, and
  // twenty "lines" of a decoded PNG is mojibake a caller would have to recognise as such.
  it("refuses a window of a file that is not text rather than slicing bytes", async () => {
    fs.writeFileSync(abs("blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));

    const res = await window("path=blob.bin&raw=1&offset=0&limit=1");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "INVALID_REQUEST",
      error: expect.stringMatching(/not a text file/),
    });
  });

  // The parameters are checked before the file is opened, so an unreadable request costs no read and a
  // caller that got both wrong is told about the one it can fix without guessing.
  it("checks the window before reading, so a bad one is refused whether or not the path exists", async () => {
    const res = await window("path=nope.txt&offset=abc");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_REQUEST", details: { field: "offset" } });
  });
});

describe("files/content PUT — save", () => {
  it("overwrites an existing file without leaving trailing content", async () => {
    fs.writeFileSync(abs("edit-me.txt"), "a much longer original value");

    const res = await putFile("edit-me.txt", "short");

    expect(res.status).toBe(200);
    expect(fs.readFileSync(abs("edit-me.txt"), "utf8")).toBe("short");
  });
});

// The classifier's codes are only worth having if they survive the trip out: each one has to reach the
// wire with the status STATUS_BY_CODE assigns it, and without the host path libuv puts in its message.
describe("files/content — errno reaches the client as a code", () => {
  const deleteFile = (p: string) =>
    DELETE(new Request(`http://x/api/files/content?path=${encodeURIComponent(p)}`, { method: "DELETE" }), ctx);

  it("answers a permission failure with FILE_NOT_WRITABLE at 409, naming no host path", async () => {
    fs.mkdirSync(abs("locked"));
    fs.writeFileSync(abs("locked/pinned.txt"), "x");
    fs.chmodSync(abs("locked"), 0o555);

    let body: { code?: string; error?: string };
    let status: number;
    try {
      const res = await deleteFile("locked/pinned.txt");
      status = res.status;
      body = await res.json();
    } finally {
      fs.chmodSync(abs("locked"), 0o755);
    }

    // Deliberately not 403: server.ts already answers 403 for a CSRF rejection, so a read-only file
    // sharing that status would be indistinguishable from a request that was refused outright.
    expect(status).toBe(409);
    expect(body.code).toBe("FILE_NOT_WRITABLE");
    expect(body.error).not.toContain(WS_DIR);
  });

  it("answers a missing delete target with NOT_FOUND at 404", async () => {
    const res = await deleteFile("never-there.txt");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });
});

describe("files/content PATCH — move", () => {
  it("moves a file into a folder", async () => {
    fs.writeFileSync(abs("move-me.txt"), "move me");
    fs.mkdirSync(abs("archive"));

    const res = await patchMove({ sourcePaths: ["move-me.txt"], destinationDirectory: "archive" });

    expect(res.status).toBe(200);
    expect(fs.existsSync(abs("move-me.txt"))).toBe(false);
    expect(fs.readFileSync(abs("archive/move-me.txt"), "utf8")).toBe("move me");
  });

  it("does not recreate the old path when a save arrives after a move", async () => {
    fs.writeFileSync(abs("move-then-save.txt"), "saved before move");
    fs.mkdirSync(abs("moved-before-save"));

    expect(
      (await patchMove({ sourcePaths: ["move-then-save.txt"], destinationDirectory: "moved-before-save" })).status,
    ).toBe(200);
    const saveRes = await putFile("move-then-save.txt", "late editor draft");

    expect(saveRes.status).toBe(409);
    expect((await saveRes.json()).code).toBe("CONFLICT");
    expect(fs.existsSync(abs("move-then-save.txt"))).toBe(false);
    expect(fs.readFileSync(abs("moved-before-save/move-then-save.txt"), "utf8")).toBe("saved before move");
  });

  it("moves a folder into another folder without merging", async () => {
    fs.mkdirSync(abs("move-folder"));
    fs.mkdirSync(abs("folder-archive"));
    fs.writeFileSync(abs("move-folder/nested.txt"), "nested");

    const res = await patchMove({ sourcePaths: ["move-folder"], destinationDirectory: "folder-archive" });

    expect(res.status).toBe(200);
    expect(fs.existsSync(abs("move-folder"))).toBe(false);
    expect(fs.readFileSync(abs("folder-archive/move-folder/nested.txt"), "utf8")).toBe("nested");
  });

  it("rejects moving a folder into one of its descendants", async () => {
    fs.mkdirSync(abs("parent/child"), { recursive: true });

    const res = await patchMove({ sourcePaths: ["parent"], destinationDirectory: "parent/child" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/into itself/i);
    expect(fs.existsSync(abs("parent/child"))).toBe(true);
  });

  it("returns a conflict without overwriting an existing item", async () => {
    fs.mkdirSync(abs("from"));
    fs.mkdirSync(abs("to"));
    fs.writeFileSync(abs("from/same.txt"), "source");
    fs.writeFileSync(abs("to/same.txt"), "destination");

    const res = await patchMove({ sourcePaths: ["from/same.txt"], destinationDirectory: "to" });

    expect(res.status).toBe(409);
    expect(fs.readFileSync(abs("from/same.txt"), "utf8")).toBe("source");
    expect(fs.readFileSync(abs("to/same.txt"), "utf8")).toBe("destination");
  });

  // The mkdir reservation carries this case alone: rename(2) replaces an empty directory happily,
  // so without the reservation an empty same-named folder is silently clobbered and the 409 never
  // fires. A non-empty one is caught by rename's own ENOTEMPTY, which is why it can't pin this.
  it("returns a conflict rather than replacing an empty same-named folder", async () => {
    fs.mkdirSync(abs("empty-from/dup"), { recursive: true });
    fs.mkdirSync(abs("empty-to/dup"), { recursive: true });
    fs.writeFileSync(abs("empty-from/dup/mine.txt"), "mine");

    const res = await patchMove({ sourcePaths: ["empty-from/dup"], destinationDirectory: "empty-to" });

    expect(res.status).toBe(409);
    expect(fs.readFileSync(abs("empty-from/dup/mine.txt"), "utf8")).toBe("mine");
    expect(fs.readdirSync(abs("empty-to/dup"))).toEqual([]);
  });

  // Folders take the mkdir-reserve-then-rename path rather than the files' link-then-unlink one,
  // so a same-named folder at the destination has to be rejected outright: merging the two trees
  // would be a silent, unrecoverable mix of the user's files.
  it("returns a conflict without merging into a same-named folder", async () => {
    fs.mkdirSync(abs("merge-from/dup"), { recursive: true });
    fs.mkdirSync(abs("merge-to/dup"), { recursive: true });
    fs.writeFileSync(abs("merge-from/dup/mine.txt"), "mine");
    fs.writeFileSync(abs("merge-to/dup/theirs.txt"), "theirs");

    const res = await patchMove({ sourcePaths: ["merge-from/dup"], destinationDirectory: "merge-to" });

    expect(res.status).toBe(409);
    expect(fs.readFileSync(abs("merge-from/dup/mine.txt"), "utf8")).toBe("mine");
    expect(fs.readFileSync(abs("merge-to/dup/theirs.txt"), "utf8")).toBe("theirs");
    expect(fs.existsSync(abs("merge-to/dup/mine.txt"))).toBe(false);
  });

  it("returns a conflict when a file collides with a same-named folder", async () => {
    fs.mkdirSync(abs("clash-to/clash"), { recursive: true });
    fs.writeFileSync(abs("clash"), "filedata");

    const res = await patchMove({ sourcePaths: ["clash"], destinationDirectory: "clash-to" });

    expect(res.status).toBe(409);
    expect(fs.readFileSync(abs("clash"), "utf8")).toBe("filedata");
    expect(fs.statSync(abs("clash-to/clash")).isDirectory()).toBe(true);
  });

  it("rejects a destination outside the workspace", async () => {
    fs.writeFileSync(abs("stay-put.txt"), "safe");

    const res = await patchMove({ sourcePaths: ["stay-put.txt"], destinationDirectory: ".." });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/escapes the workspace/i);
    expect(fs.readFileSync(abs("stay-put.txt"), "utf8")).toBe("safe");
  });

  it("rejects an absolute destination even when it names the workspace itself", async () => {
    fs.writeFileSync(abs("absolute-dest.txt"), "safe");

    const res = await patchMove({ sourcePaths: ["absolute-dest.txt"], destinationDirectory: WS_DIR });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must be relative/i);
    expect(fs.readFileSync(abs("absolute-dest.txt"), "utf8")).toBe("safe");
  });

  // The browser can only act on a path it can find in the tree it was served, and an external client
  // cannot know the host directory at all. Returning anything but the tree's own space silently breaks
  // selection and expansion state — and used to leak the host layout on every move.
  it("returns the new path in the same space the file tree serves", async () => {
    fs.mkdirSync(abs("inbox"));
    fs.writeFileSync(abs("tracked.txt"), "x");

    const res = await patchMove({ sourcePaths: [await treePathOf("tracked.txt")], destinationDirectory: "inbox" });

    expect(res.status).toBe(200);
    const moved = (await res.json()).results[0].path;
    expect(moved).toBe("inbox/tracked.txt");
    const inbox = (await buildTree(WS_DIR)).find((n) => n.name === "inbox")!;
    expect(inbox.children!.map((c) => c.path)).toContain(moved);
  });

  it("reports a move into the folder the item is already in as unchanged", async () => {
    fs.writeFileSync(abs("already-here.txt"), "x");
    const sourcePath = await treePathOf("already-here.txt");

    // null is how the client names the workspace root as a destination.
    const res = await patchMove({ sourcePaths: [sourcePath], destinationDirectory: null });

    expect(res.status).toBe(200);
    // The client keys its no-op check off `unchanged`, and echoes `path` back into its own state.
    expect(await res.json()).toEqual({
      ok: true,
      results: [{ sourcePath, path: sourcePath, unchanged: true }],
    });
    expect(fs.existsSync(abs("already-here.txt"))).toBe(true);
  });

  // A symlink that escapes the workspace never reaches the symlink rule — containment resolves it
  // to the host file and rejects it there. The host file must be left untouched either way.
  it("refuses to move a symlink that escapes the workspace", async () => {
    fs.mkdirSync(abs("sym-dest"));

    const res = await patchMove({ sourcePaths: ["escape"], destinationDirectory: "sym-dest" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/outside the workspace/i);
    expect(fs.lstatSync(abs("escape")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(path.dirname(WS_DIR), "secret.txt"), "utf8")).toBe("TOPSECRET");
  });

  // A symlink pointing *inside* the workspace passes containment, so it is the case the dedicated
  // symlink rule exists for: moving it by its resolved target would silently move hello.txt.
  it("refuses to move a symlink that stays inside the workspace", async () => {
    fs.symlinkSync(abs("hello.txt"), abs("hello-link"));
    fs.mkdirSync(abs("link-dest"));

    const res = await patchMove({ sourcePaths: ["hello-link"], destinationDirectory: "link-dest" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/symbolic link/i);
    expect(fs.lstatSync(abs("hello-link")).isSymbolicLink()).toBe(true);
    // The link's target stayed where it was rather than being moved in its place.
    expect(fs.existsSync(abs("hello.txt"))).toBe(true);
    expect(fs.readdirSync(abs("link-dest"))).toEqual([]);
  });

  it("refuses to move the workspace root", async () => {
    const res = await patchMove({ sourcePaths: ["."], destinationDirectory: null });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/workspace root/i);
  });

  it("rejects a malformed body without throwing", async () => {
    expect((await patchMove("{not json")).status).toBe(400);
    expect((await patchMove(null)).status).toBe(400);
    expect((await patchMove({ destinationDirectory: null })).status).toBe(400);
  });

  it("rejects an invalid destination type instead of treating it as the workspace root", async () => {
    fs.writeFileSync(abs("typed-destination.txt"), "stay");

    const res = await patchMove({ sourcePaths: ["typed-destination.txt"], destinationDirectory: false });

    expect(res.status).toBe(400);
    expect(fs.readFileSync(abs("typed-destination.txt"), "utf8")).toBe("stay");
  });

  it("rejects a batch with no items", async () => {
    expect((await patchMove({ sourcePaths: [], destinationDirectory: null })).status).toBe(400);
    expect((await patchMove({ sourcePaths: "not-an-array" })).status).toBe(400);
    expect((await patchMove({ sourcePaths: [""] })).status).toBe(400);
  });

  // One unsayable path refuses the whole batch rather than moving the items ahead of it first: a
  // client that mistyped one path gets to fix it and retry, instead of retrying a half-applied move.
  it("refuses a whole batch containing one invalid path, moving nothing", async () => {
    fs.mkdirSync(abs("all-or-nothing"));
    fs.writeFileSync(abs("valid-first.txt"), "x");

    const res = await patchMove({
      sourcePaths: ["valid-first.txt", "../secret.txt"],
      destinationDirectory: "all-or-nothing",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    // A refusal carries the whole error envelope AND the empty result list: the client tells a rejected
    // batch from a request that was never understood by whether `results` is there at all.
    expect(body).toMatchObject({ ok: false, code: "INVALID_REQUEST", results: [] });
    expect(fs.existsSync(abs("valid-first.txt"))).toBe(true);
    expect(fs.readdirSync(abs("all-or-nothing"))).toEqual([]);
  });

  it("moves every item of a batch in one request", async () => {
    fs.mkdirSync(abs("batch-dest"));
    const names = ["one.txt", "two.txt", "three.txt"];
    for (const n of names) fs.writeFileSync(abs(`batch-${n}`), n);
    const sourcePaths = names.map((n) => `batch-${n}`);

    const res = await patchMove({ sourcePaths, destinationDirectory: "batch-dest" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.results.map((r: { sourcePath: string }) => r.sourcePath)).toEqual(sourcePaths);
    for (const n of names) {
      expect(fs.readFileSync(abs(`batch-dest/batch-${n}`), "utf8")).toBe(n);
      expect(fs.existsSync(abs(`batch-${n}`))).toBe(false);
    }
  });

  // The reason the batch endpoint exists: a request-and-snapshot per item is what made large
  // selections crawl, so a batch must cost exactly one snapshot however many items it carries.
  it("takes a single snapshot for the whole batch", async () => {
    fs.mkdirSync(abs("snap-dest"));
    const sourcePaths = ["a", "b", "c", "d"].map((n) => `snap-${n}.txt`);
    for (const p of sourcePaths) fs.writeFileSync(abs(p), "x");

    commitResult.mockClear();
    const res = await patchMove({ sourcePaths, destinationDirectory: "snap-dest" });

    expect(res.status).toBe(200);
    expect(commitResult).toHaveBeenCalledTimes(1);
    expect(commitResult.mock.calls[0][2]).toMatch(/moved 4 items to snap-dest/);
  });

  it("does not snapshot a batch that changed nothing", async () => {
    fs.writeFileSync(abs("noop.txt"), "x");

    commitResult.mockClear();
    const res = await patchMove({ sourcePaths: [await treePathOf("noop.txt")], destinationDirectory: null });

    expect(res.status).toBe(200);
    expect(commitResult).not.toHaveBeenCalled();
  });

  it("stops at the first failure and reports the items that already moved", async () => {
    fs.mkdirSync(abs("partial-dest"));
    const sources = ["partial-first.txt", "partial-blocked.txt", "partial-never.txt"];
    for (const p of sources) fs.writeFileSync(abs(p), "x");
    // Pre-occupy the middle item's destination so it, and only it, conflicts.
    fs.writeFileSync(abs("partial-dest/partial-blocked.txt"), "occupied");

    const res = await patchMove({ sourcePaths: sources, destinationDirectory: "partial-dest" });

    // Some of the work is real, so the batch is a 200 that carries what landed and what stopped it.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/already exists/i);
    // The reason travels as a code even here, where the status is 200 and cannot carry it.
    expect(body.code).toBe("CONFLICT");
    expect(body.failedSourcePath).toBe("partial-blocked.txt");
    expect(body.results.map((r: { sourcePath: string }) => r.sourcePath)).toEqual(["partial-first.txt"]);

    expect(fs.existsSync(abs("partial-dest/partial-first.txt"))).toBe(true);
    expect(fs.readFileSync(abs("partial-blocked.txt"), "utf8")).toBe("x");
    expect(fs.readFileSync(abs("partial-dest/partial-blocked.txt"), "utf8")).toBe("occupied");
    // The item after the failure was never attempted and must be exactly where it was.
    expect(fs.readFileSync(abs("partial-never.txt"), "utf8")).toBe("x");
  });

  // An item already in the destination is a no-op, not a failure — it must not stop the batch.
  it("keeps going past an unchanged item", async () => {
    fs.mkdirSync(abs("mixed-dest"));
    fs.writeFileSync(abs("mixed-dest/settled.txt"), "already");
    fs.writeFileSync(abs("mixed-mover.txt"), "moves");
    const settled = (await buildTree(WS_DIR))
      .find((n) => n.name === "mixed-dest")!
      .children!.find((n) => n.name === "settled.txt")!.path;

    const res = await patchMove({ sourcePaths: [settled, "mixed-mover.txt"], destinationDirectory: "mixed-dest" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.results).toEqual([
      { sourcePath: settled, path: settled, unchanged: true },
      { sourcePath: "mixed-mover.txt", path: "mixed-dest/mixed-mover.txt", unchanged: false },
    ]);
    expect(fs.readFileSync(abs("mixed-dest/mixed-mover.txt"), "utf8")).toBe("moves");
  });

  it("does not replace an existing directory", async () => {
    fs.mkdirSync(abs("dir-from/same-dir"), { recursive: true });
    fs.mkdirSync(abs("dir-to/same-dir"), { recursive: true });
    fs.writeFileSync(abs("dir-from/same-dir/source.txt"), "source");
    fs.writeFileSync(abs("dir-to/same-dir/destination.txt"), "destination");

    const res = await patchMove({ sourcePaths: ["dir-from/same-dir"], destinationDirectory: "dir-to" });

    expect(res.status).toBe(409);
    expect(fs.readFileSync(abs("dir-from/same-dir/source.txt"), "utf8")).toBe("source");
    expect(fs.readFileSync(abs("dir-to/same-dir/destination.txt"), "utf8")).toBe("destination");
  });
});

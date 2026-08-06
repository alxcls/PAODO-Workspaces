// These operations exist so file work is reachable without an HTTP request — a directory transfer is
// N of these calls and cannot synthesize N fake Requests, and an agent tool has no Request to hand
// over. This file is that claim under test: no Request, no route, no server, just a directory on disk.
//
// The route tests next to app/api/**/files/content cover the transport (status codes, raw bytes); what
// is pinned here is the vocabulary those routes translate — which failure is a NOT_FOUND, which is a
// CONFLICT, and that a write that lost a race to a move never recreates the path it lost.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { AppError } from "@/lib/errors/appError";
import { countLines, readFileEntry, removeEntry, requireLineRange, sliceLines, writeTextFile } from "./content";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "files-ops-test-"));
const WS_DIR = path.join(ROOT, "ws");
const OUTSIDE = path.join(ROOT, "outside");

beforeEach(() => {
  fs.rmSync(WS_DIR, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  fs.mkdirSync(WS_DIR, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** The AppError code a call fails with, so a test reads as the vocabulary rather than a try/catch. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
  throw new Error("expected the call to fail");
}

describe("readFileEntry", () => {
  it("classifies a UTF-8 file as text and returns its content", async () => {
    fs.writeFileSync(path.join(WS_DIR, "notes.md"), "# hello");
    const file = await readFileEntry(WS_DIR, "notes.md");
    expect(file).toMatchObject({ type: "text", content: "# hello" });
  });

  it("classifies bytes that are not valid UTF-8 as binary, and still hands back the bytes", async () => {
    fs.writeFileSync(path.join(WS_DIR, "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const file = await readFileEntry(WS_DIR, "blob.bin");
    expect(file.type).toBe("binary");
    expect(file.bytes.length).toBe(4);
  });

  // SVG is text that the viewer should render as a picture, so it is deliberately not "text".
  it("classifies an SVG as an image", async () => {
    fs.writeFileSync(path.join(WS_DIR, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(await readFileEntry(WS_DIR, "logo.svg")).toMatchObject({ type: "image", mimeType: "image/svg+xml" });
  });

  it("reports a missing file as NOT_FOUND, not as a bad request", async () => {
    expect(await codeOf(() => readFileEntry(WS_DIR, "nope.txt"))).toBe("NOT_FOUND");
  });

  it("reports a directory as an invalid request rather than letting EISDIR escape", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src"));
    expect(await codeOf(() => readFileEntry(WS_DIR, "src"))).toBe("INVALID_REQUEST");
  });

  it("refuses a symlink that leaves the tree, which a lexical path check would have allowed", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "TOPSECRET");
    fs.symlinkSync(path.join(OUTSIDE, "secret.txt"), path.join(WS_DIR, "escape"));
    expect(await codeOf(() => readFileEntry(WS_DIR, "escape"))).toBe("INVALID_REQUEST");
  });
});

// A window is asked for by a caller that cannot hold the whole file, so the two ways it can quietly go
// wrong are the ones to pin: lines that come back shifted from the ones asked for, and a range the
// caller got wrong answering with content instead of a refusal.
describe("requireLineRange", () => {
  it("is null only when neither value was named, so a caller that never pages is unaffected", () => {
    expect(requireLineRange(null, null)).toBeNull();
    expect(requireLineRange(undefined, undefined)).toBeNull();
  });

  it("defaults the unnamed half: an offset alone runs to the end, a limit alone starts at the top", () => {
    expect(requireLineRange("49", null)).toEqual({ offset: 49 });
    expect(requireLineRange(null, "50")).toEqual({ offset: 0, limit: 50 });
    expect(requireLineRange("49", "50")).toEqual({ offset: 49, limit: 50 });
  });

  // Rounding or ignoring any of these would answer with a different part of the file than the caller
  // named, and the lines that come back say nothing about which part they are.
  it("refuses a value that is not a whole number, and names which one it was", () => {
    for (const offset of ["abc", "1.5", "-1", "", " ", "1e3x", "Infinity"]) {
      expect(() => requireLineRange(offset, null)).toThrow(AppError);
      try {
        requireLineRange(offset, null);
      } catch (err) {
        expect(err).toMatchObject({ code: "INVALID_REQUEST", details: { field: "offset" } });
      }
    }
    // Offset counts from zero and limit counts lines, so zero means something for one and nothing for
    // the other — a `limit: 0` that answered with an empty file would read as an empty file.
    expect(requireLineRange("0", null)).toEqual({ offset: 0 });
    expect(() => requireLineRange(null, "0")).toThrow(AppError);
  });
});

describe("sliceLines", () => {
  const FILE = "one\ntwo\nthree\nfour\n";

  it("counts the offset from zero and the limit in lines", () => {
    expect(sliceLines(FILE, { offset: 0, limit: 2 })).toBe("one\ntwo\n");
    expect(sliceLines(FILE, { offset: 1, limit: 2 })).toBe("two\nthree\n");
    expect(sliceLines(FILE, { offset: 2 })).toBe("three\nfour\n");
    expect(sliceLines(FILE, { offset: 0 })).toBe(FILE);
  });

  it("does not count the terminator as a line, so the last line is reachable and the end is empty", () => {
    expect(sliceLines(FILE, { offset: 3, limit: 1 })).toBe("four\n");
    expect(sliceLines(FILE, { offset: 4 })).toBe("");
    expect(sliceLines(FILE, { offset: 99, limit: 10 })).toBe("");
    expect(sliceLines("", { offset: 0 })).toBe("");
  });

  // So `cat --offset` of the tail of a file is byte-identical to the tail of that file: a caller
  // reading a file in windows and joining them back gets the file, not the file plus a newline.
  it("keeps each line's own terminator, including a last line that never had one", () => {
    expect(sliceLines("one\ntwo", { offset: 1 })).toBe("two");
    expect(sliceLines("one\ntwo", { offset: 0, limit: 1 })).toBe("one\n");
    expect(sliceLines("one\r\ntwo\r\n", { offset: 0, limit: 1 })).toBe("one\r\n");
    expect(sliceLines("\n\n", { offset: 1 })).toBe("\n");
  });
});

describe("countLines", () => {
  it("does not count the terminator, so a file with and without a trailing newline agree", () => {
    expect(countLines("one\ntwo\nthree\nfour\n")).toBe(4);
    expect(countLines("one\ntwo\nthree\nfour")).toBe(4);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\n")).toBe(1);
    expect(countLines("\n\n")).toBe(2);
  });

  // An empty file has nothing to read, not one empty line — which is what lets a caller read `lines: 0`
  // as "do not bother" rather than as a line it should go and fetch.
  it("counts an empty file as no lines at all", () => {
    expect(countLines("")).toBe(0);
  });

  // The property that matters, stated as one: this is the count a listing reports so a caller can pick
  // a window, and sliceLines is what applies that window. If they disagreed by one, every caller
  // reading a file to its end would either miss its last line or ask for one past it — and the content
  // it did get back would look perfectly correct.
  it("is exactly the number of lines sliceLines can reach", () => {
    for (const content of ["", "one", "one\n", "one\ntwo", "one\ntwo\n", "\n\n", "a\r\nb\r\n", "\n"]) {
      const total = countLines(content);
      // Every line up to the count is reachable, and the one past it is not.
      for (let offset = 0; offset < total; offset++) {
        expect(sliceLines(content, { offset, limit: 1 })).not.toBe("");
      }
      expect(sliceLines(content, { offset: total, limit: 1 })).toBe("");
      // And reading from the top for exactly that many lines is the whole file back.
      expect(sliceLines(content, { offset: 0, limit: total || 1 })).toBe(content);
    }
  });
});

describe("writeTextFile", () => {
  it("overwrites in place, leaving no trailing content from the longer previous value", async () => {
    fs.writeFileSync(path.join(WS_DIR, "edit.txt"), "a much longer original value");
    await writeTextFile(WS_DIR, "edit.txt", "short");
    expect(fs.readFileSync(path.join(WS_DIR, "edit.txt"), "utf8")).toBe("short");
  });

  // The O_CREAT-less open is the whole point: a save racing a move must fail rather than resurrect the
  // path the move emptied, which would leave the user with the file in two places.
  it("reports a write to a path that no longer exists as a CONFLICT and creates nothing", async () => {
    expect(await codeOf(() => writeTextFile(WS_DIR, "vanished.txt", "draft"))).toBe("CONFLICT");
    expect(fs.existsSync(path.join(WS_DIR, "vanished.txt"))).toBe(false);
  });

  it("reports the saved file to afterWrite by name, so a snapshot can label itself", async () => {
    fs.writeFileSync(path.join(WS_DIR, "src-file.txt"), "x");
    const labels: string[] = [];
    await writeTextFile(WS_DIR, "src-file.txt", "y", { afterWrite: async (m) => void labels.push(m) });
    expect(labels).toEqual(["saved src-file.txt"]);
  });

  // The fallback covers legacy root-owned files by writing through the container, so it receives the
  // path in the container's own space — relative — not a host path it would have to convert back.
  it("hands the fallback a workspace-relative path when the host write is refused", async () => {
    const target = path.join(WS_DIR, "readonly.txt");
    fs.writeFileSync(target, "original");
    fs.chmodSync(target, 0o444);
    const seen: string[] = [];
    try {
      await writeTextFile(WS_DIR, "readonly.txt", "new", {
        writeFallback: async (relPath) => void seen.push(relPath),
      });
    } finally {
      fs.chmodSync(target, 0o644);
    }
    expect(seen).toEqual(["readonly.txt"]);
  });
});

describe("removeEntry", () => {
  it("removes a file", async () => {
    fs.writeFileSync(path.join(WS_DIR, "gone.txt"), "x");
    await removeEntry(WS_DIR, "gone.txt");
    expect(fs.existsSync(path.join(WS_DIR, "gone.txt"))).toBe(false);
  });

  it("removes a directory and everything under it", async () => {
    fs.mkdirSync(path.join(WS_DIR, "tree", "deep"), { recursive: true });
    fs.writeFileSync(path.join(WS_DIR, "tree", "deep", "leaf.txt"), "x");
    await removeEntry(WS_DIR, "tree");
    expect(fs.existsSync(path.join(WS_DIR, "tree"))).toBe(false);
  });

  it("reports a missing entry as NOT_FOUND", async () => {
    expect(await codeOf(() => removeEntry(WS_DIR, "never-existed.txt"))).toBe("NOT_FOUND");
  });

  // Deleting through a symlink would remove the link's target elsewhere on the host, not the row the
  // client asked about.
  it("refuses to delete through a symlink that leaves the tree, and leaves the target alone", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "TOPSECRET");
    fs.symlinkSync(path.join(OUTSIDE, "secret.txt"), path.join(WS_DIR, "escape"));
    expect(await codeOf(() => removeEntry(WS_DIR, "escape"))).toBe("INVALID_REQUEST");
    expect(fs.readFileSync(path.join(OUTSIDE, "secret.txt"), "utf8")).toBe("TOPSECRET");
  });
});

// The claim item 2 exists for: many files, one after another, with no HTTP anywhere in sight.
describe("used as a batch, without a Request", () => {
  it("writes a whole directory's worth of files and reports each one", async () => {
    const names = ["a.txt", "nested/b.txt", "nested/deep/c.txt"];
    for (const name of names) {
      await fsp.mkdir(path.dirname(path.join(WS_DIR, name)), { recursive: true });
      await fsp.writeFile(path.join(WS_DIR, name), "");
    }

    const labels: string[] = [];
    for (const name of names) {
      await writeTextFile(WS_DIR, name, `content of ${name}`, { afterWrite: async (m) => void labels.push(m) });
    }

    expect(labels).toEqual(["saved a.txt", "saved b.txt", "saved c.txt"]);
    for (const name of names) {
      expect(fs.readFileSync(path.join(WS_DIR, name), "utf8")).toBe(`content of ${name}`);
    }
  });
});

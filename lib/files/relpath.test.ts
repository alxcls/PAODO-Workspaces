// The wire path space is the one thing every file client — the browser, the CLI, an agent tool — has
// to agree with the server about, so what a caller is allowed to *say* is pinned here rather than
// inferred from whichever route happens to be reading it.
//
// Two properties matter beyond the individual cases:
//   - a rejection names the right form, because the caller most likely to get this wrong is a model
//     that will otherwise retry the same string;
//   - a directory and the same directory with a trailing slash are one key, because the browser uses
//     the result as its selection and expansion identity.

import { describe, it, expect } from "vitest";
import { InvalidPathError, relativeDirPath, relativeEntryPath, toRelativePath } from "./relpath";

const refuses = (clientPath: string, pattern: RegExp) =>
  expect(() => relativeEntryPath(clientPath)).toThrow(
    expect.objectContaining({ name: "InvalidPathError", message: expect.stringMatching(pattern) }),
  );

describe("relativeEntryPath", () => {
  it("keeps an ordinary relative path as it is", () => {
    expect(relativeEntryPath("src/main.ts")).toBe("src/main.ts");
    expect(relativeEntryPath("notes.md")).toBe("notes.md");
  });

  it("normalizes the spellings of one path to a single identity key", () => {
    expect(relativeEntryPath("./src/main.ts")).toBe("src/main.ts");
    expect(relativeEntryPath("src//main.ts")).toBe("src/main.ts");
    expect(relativeEntryPath("src/lib/../main.ts")).toBe("src/main.ts");
    expect(relativeEntryPath("  src/main.ts  ")).toBe("src/main.ts");
    // "src/" and "src" name the same directory and must not become two selection keys.
    expect(relativeEntryPath("src/")).toBe("src");
  });

  it("refuses an absolute path", () => {
    refuses("/etc/passwd", /must be relative/i);
    refuses("/", /must be relative/i);
  });

  // The single most likely mistake: an agent that has been editing /workspace/src/main.ts through its
  // own container tools reaches for the same string here. The message has to carry the answer.
  it("names the correct form when given the container's mount path", () => {
    refuses("/workspace/src/main.ts", /drop the "\/workspace\/" prefix and use "src\/main\.ts"/);
    refuses("/workspace", /use "\."/);
  });

  it("refuses an escape, however it is spelled", () => {
    refuses("..", /escapes the root/i);
    refuses("../secret.txt", /escapes the root/i);
    refuses("src/../../secret.txt", /escapes the root/i);
    refuses("./../secret.txt", /escapes the root/i);
  });

  it("refuses a path that resolves to the root, which names no entry", () => {
    refuses(".", /names the root/i);
    refuses("", /names the root/i);
    refuses("src/..", /names the root/i);
  });

  // fs rejects a null byte with ERR_INVALID_ARG_VALUE, which carries no errno and would otherwise
  // surface as an opaque 500 rather than a bad request.
  it("refuses a null byte before it reaches fs", () => {
    refuses("src/main\0.ts", /null byte/i);
  });

  it("carries the path it refused, for logging that does not have to re-derive it", () => {
    try {
      relativeEntryPath("/workspace/x");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPathError);
      expect((err as InvalidPathError).attemptedPath).toBe("/workspace/x");
    }
  });

  it("allows a dotted or oddly named entry — only the rules above are rules", () => {
    expect(relativeEntryPath(".env")).toBe(".env");
    expect(relativeEntryPath("a b/c-d.e_f")).toBe("a b/c-d.e_f");
    expect(relativeEntryPath("...")).toBe("...");
    // "..foo" starts with two dots without being a traversal.
    expect(relativeEntryPath("..foo")).toBe("..foo");
  });
});

describe("relativeDirPath", () => {
  it("treats every spelling of the root as the root", () => {
    expect(relativeDirPath(null)).toBe("");
    expect(relativeDirPath(undefined)).toBe("");
    expect(relativeDirPath("")).toBe("");
    expect(relativeDirPath(".")).toBe("");
    expect(relativeDirPath("./")).toBe("");
  });

  it("applies the same refusals as an entry path", () => {
    expect(() => relativeDirPath("..")).toThrow(/escapes the root/i);
    expect(() => relativeDirPath("/tmp")).toThrow(/must be relative/i);
  });

  it("keeps a real directory path", () => {
    expect(relativeDirPath("src/lib")).toBe("src/lib");
    expect(relativeDirPath("src/lib/")).toBe("src/lib");
  });
});

describe("toRelativePath", () => {
  it("converts the absolute paths the OS reports into the wire space", () => {
    expect(toRelativePath("/data/ws", "/data/ws/src/main.ts")).toBe("src/main.ts");
    expect(toRelativePath("/data/ws", "/data/ws")).toBe("");
  });

  it("round-trips with relativeEntryPath, which is what the tree and the watcher rely on", () => {
    const relPath = toRelativePath("/data/ws", "/data/ws/src/main.ts");
    expect(relativeEntryPath(relPath)).toBe(relPath);
  });
});

// The containment guard's closure property, swept over ~86k generated paths.
//
// pathUtils.test.ts pins named cases. This file pins the invariant those cases are examples of:
// whatever normalizeRelpath/normalizeDirPath emit is ALWAYS a clean workspace-relative path — no
// leading slash, no ".." segment, and unchanged if fed back in. That is what makes accepting the
// container's "/workspace/x" spelling a rename rather than a widening: the output set is exactly
// the set of paths that were already reachable by typing them relatively, so no file became
// addressable that was not addressable before.
//
// STRICT below is the guard reduced to its harshest form — reject anything absolute or ascending.
// Every emitted path must survive it untouched, whichever spelling produced it.

import { describe, it, expect } from "vitest";
import path from "path";
import { normalizeRelpath, normalizeDirPath } from "./pathUtils";

function strict(filePath: string): string | null {
  const n = path.posix.normalize(filePath);
  return n.startsWith("..") || n.startsWith("/") ? null : n;
}

const SEGMENTS = ["", "/", "//", ".", "..", "workspace", "workspacefoo", "etc", "passwd", "a", "b", ".ssh", "~"];

// Each quadruple is emitted three ways — relative, absolute, and rooted at /workspace — so the
// same escape attempt is tested in every spelling that could reach the guard.
function* inputs(): Generator<string> {
  for (const a of SEGMENTS)
    for (const b of SEGMENTS)
      for (const c of SEGMENTS)
        for (const d of SEGMENTS) {
          const joined = [a, b, c, d].join("/");
          yield joined;
          yield `/${joined}`;
          yield `/workspace/${joined}`;
        }
}

function expectContained(out: string, from: string) {
  expect(strict(out), `input ${JSON.stringify(from)} -> ${JSON.stringify(out)}`).toBe(out);
  expect(out.split("/")).not.toContain("..");
  expect(out.startsWith("/")).toBe(false);
}

describe("containment closure", () => {
  it("normalizeRelpath only ever emits an already-contained relative path", () => {
    let emitted = 0;
    for (const s of inputs()) {
      const out = normalizeRelpath(s);
      if (out === null) continue;
      emitted++;
      expectContained(out, s);
    }
    // Guards the sweep itself: a guard that rejected everything would pass the loop vacuously.
    expect(emitted).toBeGreaterThan(500);
  });

  it("normalizeDirPath does the same, with the root as its one extra legal answer", () => {
    for (const s of inputs()) {
      const out = normalizeDirPath(s);
      if (out === null || out === ".") continue;
      expectContained(out, s);
    }
  });

  it("leaves every path that does not start at the workspace root exactly as the strict rule would", () => {
    for (const s of inputs()) {
      if (path.posix.normalize(s).startsWith("/workspace")) continue;
      expect(normalizeRelpath(s), `input ${JSON.stringify(s)}`).toBe(strict(s));
    }
  });
});

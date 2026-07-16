import { describe, expect, it } from "vitest";
import {
  canMoveToDirectory,
  EditorFileMutationLock,
  isPathWithinRoot,
  remapMovedPath,
} from "./fileMove";

describe("remapMovedPath", () => {
  it("remaps the moved item and its descendants", () => {
    expect(remapMovedPath("/ws/src", "/ws/src", "/ws/archive/src")).toBe("/ws/archive/src");
    expect(remapMovedPath("/ws/src/index.ts", "/ws/src", "/ws/archive/src"))
      .toBe("/ws/archive/src/index.ts");
  });

  it("does not remap similarly prefixed siblings", () => {
    expect(remapMovedPath("/ws/src-old/index.ts", "/ws/src", "/ws/archive/src"))
      .toBe("/ws/src-old/index.ts");
  });
});

describe("canMoveToDirectory", () => {
  const folder = { path: "/ws/src", type: "directory" as const };

  it("rejects a folder's own subtree", () => {
    expect(canMoveToDirectory(folder, "/ws/src")).toBe(false);
    expect(canMoveToDirectory(folder, "/ws/src/nested")).toBe(false);
  });

  it("allows files and unrelated destination folders", () => {
    expect(canMoveToDirectory(folder, "/ws/archive")).toBe(true);
    expect(canMoveToDirectory({ path: "/ws/src/a.ts", type: "file" }, "/ws/src")).toBe(true);
  });
});

describe("isPathWithinRoot", () => {
  it("matches a root and its descendants, but not similarly prefixed siblings", () => {
    expect(isPathWithinRoot("/ws/src", "/ws/src")).toBe(true);
    expect(isPathWithinRoot("/ws/src/a.ts", "/ws/src")).toBe(true);
    expect(isPathWithinRoot("/ws/src-old/a.ts", "/ws/src")).toBe(false);
  });
});

describe("EditorFileMutationLock", () => {
  it("blocks moving a file or parent folder while that file is being saved", () => {
    const lock = new EditorFileMutationLock();
    expect(lock.startMutation("/ws/src/a.ts")).toBe(true);
    expect(lock.startMove("/ws/src/a.ts", "/ws/src/a.ts")).toBe(false);
    expect(lock.startMove("/ws/src", "/ws/src/a.ts")).toBe(false);
    expect(lock.startMove("/ws/other", "/ws/src/a.ts")).toBe(true);

    lock.finishMutation();
    expect(lock.startMove("/ws/src", "/ws/src/a.ts")).toBe(true);
  });

  it("blocks a save from starting while its file is being moved", () => {
    const lock = new EditorFileMutationLock();
    expect(lock.startMove("/ws/src", "/ws/src/a.ts")).toBe(true);
    expect(lock.pendingMoveRoot).toBe("/ws/src");
    expect(lock.startMove("/ws/other", "/ws/src/a.ts")).toBe(false);
    expect(lock.startMutation("/ws/src/a.ts")).toBe(false);

    lock.finishMove("/ws/src");
    expect(lock.startMutation("/ws/src/a.ts")).toBe(true);
  });
});

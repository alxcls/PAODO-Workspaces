// resolveDriveDir is the single resolver every drive_* tool funnels through. It must accept
// EITHER a drive's id (the stable handle agents pass to each other) OR its name (case-insensitive),
// and stay scoped to the drives the calling workspace is actually connected to.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "drivestore-test-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// driveStore captures WORKSPACES_ROOT at module load, so point it at a clean temp dir and
// re-import for each test.
async function freshStore() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.WORKSPACES_ROOT = ROOT;
  vi.resetModules();
  return import("./driveStore");
}

let store: typeof import("./driveStore");

beforeEach(async () => {
  store = await freshStore();
});

describe("resolveDriveDir", () => {
  it("resolves a connected drive by its id", () => {
    const drive = store.createDrive("articles", "shared feed");
    store.connectDrive(drive.id, "ws1");
    const resolved = store.resolveDriveDir("ws1", drive.id);
    expect(resolved?.drive.id).toBe(drive.id);
    expect(resolved?.dir).toBe(store.driveContentDir(drive.id));
  });

  it("resolves a connected drive by name, case-insensitively", () => {
    const drive = store.createDrive("Articles");
    store.connectDrive(drive.id, "ws1");
    expect(store.resolveDriveDir("ws1", "articles")?.drive.id).toBe(drive.id);
    expect(store.resolveDriveDir("ws1", "ARTICLES")?.drive.id).toBe(drive.id);
  });

  it("returns null for a drive the workspace is not connected to", () => {
    const drive = store.createDrive("articles");
    store.connectDrive(drive.id, "ws1");
    expect(store.resolveDriveDir("ws2", drive.id)).toBeNull();
    expect(store.resolveDriveDir("ws2", "articles")).toBeNull();
  });

  it("returns null for an unknown id or name", () => {
    const drive = store.createDrive("articles");
    store.connectDrive(drive.id, "ws1");
    expect(store.resolveDriveDir("ws1", "nope")).toBeNull();
    expect(store.resolveDriveDir("ws1", "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("formatDriveLine", () => {
  it("renders name, id, and description", () => {
    const drive = store.createDrive("articles", "shared feed");
    expect(store.formatDriveLine(drive)).toBe(`- articles (id: ${drive.id}) — shared feed`);
  });

  it("omits the em dash when there is no description", () => {
    const drive = store.createDrive("scratch");
    expect(store.formatDriveLine(drive)).toBe(`- scratch (id: ${drive.id})`);
  });
});

describe("drive connection persistence", () => {
  it("surfaces a connection registry write failure", () => {
    const drive = store.createDrive("articles");
    // A directory at the registry path makes atomic rename fail deterministically without mocking
    // the persistence layer, exercising the same error boundary production uses.
    fs.mkdirSync(path.join(ROOT, ".drive-connections.json"));

    expect(() => store.connectDrive(drive.id, "ws1")).toThrow();
  });
});

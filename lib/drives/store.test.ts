// resolveDriveDir is the single resolver every drive_* tool funnels through. It must accept
// EITHER a drive's id (the stable handle agents pass to each other) OR its name (case-insensitive),
// and stay scoped to the drives the calling workspace is actually connected to.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
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
  return import("./store");
}

let store: typeof import("./store");

beforeEach(async () => {
  store = await freshStore();
});

afterEach(() => {
  vi.doUnmock("fs/promises");
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

// Uniqueness is enforced in the store rather than the operation because the store is what holds the
// list to compare against — and because resolveDriveDir above, which resolves a drive_* tool's
// `driveRef` by name case-insensitively, is the reason the rule exists at all.
describe("drive name uniqueness", () => {
  const conflict = expect.objectContaining({ name: "DriveNameError", code: "DRIVE_NAME_CONFLICT" });

  it("refuses a second drive with an equivalent name", () => {
    store.createDrive("Articles");
    expect(() => store.createDrive("articles")).toThrowError(conflict);
    expect(() => store.createDrive("  ARTICLES  ")).toThrowError(conflict);
  });

  it("leaves no content directory behind for a refused name", () => {
    const first = store.createDrive("articles");
    expect(() => store.createDrive("Articles")).toThrowError(conflict);
    // The conflict is checked before mkdir, so the only drive directory is the one that took.
    expect(fs.readdirSync(path.join(ROOT, ".drives"))).toEqual([first.id]);
    expect(store.listDrives()).toHaveLength(1);
  });

  it("refuses renaming a drive onto another drive's name", () => {
    store.createDrive("articles");
    const scratch = store.createDrive("scratch");
    expect(() => store.updateDrive(scratch.id, { name: "Articles" })).toThrowError(conflict);
    expect(store.getDrive(scratch.id)?.name).toBe("scratch");
  });

  // Without the exceptId, re-sending a drive's current name (which is what a UI form submitting every
  // field does) would collide with the drive itself.
  it("allows a drive to be renamed to its own name", () => {
    const drive = store.createDrive("Articles");
    expect(store.updateDrive(drive.id, { name: "articles" })?.name).toBe("articles");
  });

  it("frees a name once the drive holding it is deleted", async () => {
    const drive = store.createDrive("articles");
    await store.deleteDrive(drive.id);
    expect(store.createDrive("articles").name).toBe("articles");
  });
});

describe("drive deletion", () => {
  it("removes content and connections before removing the registry entry", async () => {
    const drive = store.createDrive("articles");
    const contentFile = path.join(store.driveContentDir(drive.id), "private.txt");
    fs.writeFileSync(contentFile, "sensitive");
    store.connectDrive(drive.id, "ws1");

    await expect(store.deleteDrive(drive.id)).resolves.toBe(true);

    expect(fs.existsSync(store.driveContentDir(drive.id))).toBe(false);
    expect(store.listConnections()).toEqual([]);
    expect(store.getDrive(drive.id)).toBeUndefined();
  });

  it("keeps the drive registered when content deletion fails, then permits a retry", async () => {
    const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
    const failure = new Error("filesystem unavailable");
    const removeContent = vi.fn(actual.rm).mockRejectedValueOnce(failure);
    vi.doMock("fs/promises", () => ({ ...actual, rm: removeContent }));
    store = await freshStore();

    const drive = store.createDrive("articles");
    store.connectDrive(drive.id, "ws1");

    await expect(store.deleteDrive(drive.id)).rejects.toBe(failure);
    expect(store.getDrive(drive.id)).toEqual(drive);
    // Connections are removed first to stop agents discovering a drive whose content is being
    // deleted. The registry entry remains as the retry handle when the filesystem step fails.
    expect(store.listConnections()).toEqual([]);
    expect(fs.existsSync(store.driveContentDir(drive.id))).toBe(true);

    await expect(store.deleteDrive(drive.id)).resolves.toBe(true);
    expect(store.getDrive(drive.id)).toBeUndefined();
    expect(store.listConnections()).toEqual([]);
    expect(fs.existsSync(store.driveContentDir(drive.id))).toBe(false);
  });

  it("keeps the drive registered when connection cleanup fails, then permits a retry", async () => {
    const drive = store.createDrive("articles");
    const connectionsFile = path.join(ROOT, ".drive-connections.json");
    // A directory at the registry path makes the atomic rename fail deterministically.
    fs.mkdirSync(connectionsFile);

    await expect(store.deleteDrive(drive.id)).rejects.toThrow();
    expect(store.getDrive(drive.id)).toEqual(drive);
    expect(fs.existsSync(store.driveContentDir(drive.id))).toBe(true);

    // Repair the failed persistence target and retry; no content was touched before that failure.
    fs.rmSync(connectionsFile, { recursive: true, force: true });
    await expect(store.deleteDrive(drive.id)).resolves.toBe(true);
    expect(store.getDrive(drive.id)).toBeUndefined();
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

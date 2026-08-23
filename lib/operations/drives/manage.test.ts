import { describe, expect, it, vi } from "vitest";
import { createDrive, deleteDrive, getDrive, listDrives, updateDrive, type DriveDeps } from "./manage";
import type { Drive } from "@/lib/drives/store";

const drive: Drive = {
  id: "drive-1",
  name: "Shared assets",
  createdAt: "2026-08-20T09:11:04.117Z",
};

function deps(overrides: Partial<DriveDeps> = {}): DriveDeps {
  return {
    list: () => [drive],
    get: (driveId) => (driveId === "drive-1" ? drive : undefined),
    create: vi.fn(() => drive),
    update: vi.fn((driveId) => (driveId === "drive-1" ? drive : undefined)),
    remove: vi.fn(async (driveId) => driveId === "drive-1"),
    ...overrides,
  };
}

const notFound = expect.objectContaining({ code: "NOT_FOUND", message: "drive not found" });

describe("reading drives", () => {
  it("relays the registry", () => {
    expect(listDrives(deps())).toEqual([drive]);
  });

  it("returns one drive and refuses an unknown id", () => {
    expect(getDrive("drive-1", deps())).toBe(drive);
    expect(() => getDrive("gone", deps())).toThrowError(notFound);
  });

  it("refuses an empty id rather than looking it up", () => {
    const get = vi.fn(() => drive);
    expect(() => getDrive("", deps({ get }))).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(get).not.toHaveBeenCalled();
  });
});

describe("creating a drive", () => {
  it("passes the name and description to the store", () => {
    const create = vi.fn(() => drive);
    createDrive({ name: "Shared assets", description: "scratch" }, deps({ create }));
    expect(create).toHaveBeenCalledWith("Shared assets", "scratch");
  });

  it("treats an absent description as unset", () => {
    const create = vi.fn(() => drive);
    createDrive({ name: "Shared assets" }, deps({ create }));
    expect(create).toHaveBeenCalledWith("Shared assets", undefined);
  });

  it("refuses a missing name and a non-string description", () => {
    expect(() => createDrive({}, deps())).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => createDrive({ name: "ok", description: 7 }, deps())).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", message: "description must be a string" }),
    );
  });
});

describe("updating a drive", () => {
  it("sends only the fields that were supplied", () => {
    const update = vi.fn(() => drive);
    updateDrive("drive-1", { description: "scratch" }, deps({ update }));
    expect(update).toHaveBeenCalledWith("drive-1", { description: "scratch" });
  });

  // Omitted means unchanged; explicitly empty clears it, which the store already implements.
  it("passes an empty description through rather than dropping it", () => {
    const update = vi.fn(() => drive);
    updateDrive("drive-1", { description: "" }, deps({ update }));
    expect(update).toHaveBeenCalledWith("drive-1", { description: "" });
  });

  // The same receipt a workspace PATCH answers with, so both `set` verbs report a mutation alike.
  it("answers with a receipt naming only the fields it moved", () => {
    expect(updateDrive("drive-1", { name: "Shared assets" }, deps())).toEqual({
      ok: true,
      driveId: "drive-1",
      applied: { name: "Shared assets" },
    });
  });

  // The store trims and NFC-folds a name, so echoing the request back would report a spelling the
  // drive does not have.
  it("reports the stored value, not the value that was sent", () => {
    const stored = { ...drive, name: "Shared assets" };
    const receipt = updateDrive("drive-1", { name: "  Shared assets  " }, deps({ update: () => stored }));
    expect(receipt.applied).toEqual({ name: "Shared assets" });
  });

  // JSON drops an undefined value, so relaying the store's cleared `undefined` would report an
  // applied field as one that was never sent.
  it("reports a cleared description as empty rather than omitting it", () => {
    const cleared = { id: "drive-1", name: "Shared assets", createdAt: drive.createdAt };
    const receipt = updateDrive("drive-1", { description: "" }, deps({ update: () => cleared }));
    expect(receipt.applied).toEqual({ description: "" });
  });

  it("refuses a non-string description", () => {
    expect(() => updateDrive("drive-1", { description: 7 }, deps())).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", message: "description must be a string" }),
    );
  });

  it("refuses an unknown drive", () => {
    expect(() => updateDrive("gone", { name: "x" }, deps())).toThrowError(notFound);
  });

  // A typo dropped instead of refused applies the valid half and answers ok with the typo nowhere in
  // the reply: `drive set <id> descriptoin=x` reported success and changed nothing.
  it("refuses an unrecognised field instead of dropping it", () => {
    const update = vi.fn(() => drive);
    expect(() =>
      updateDrive("drive-1", { descriptoin: "typo" } as Record<string, unknown>, deps({ update })),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown field(s): descriptoin — accepted: name, description",
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses a request that sets nothing at all", () => {
    const update = vi.fn(() => drive);
    expect(() => updateDrive("drive-1", {}, deps({ update }))).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(update).not.toHaveBeenCalled();
  });
});

describe("deleting a drive", () => {
  it("reports the removal", async () => {
    await expect(deleteDrive("drive-1", deps())).resolves.toEqual({ deleted: true });
  });

  // The behaviour this operation exists for: the store answers `false` for a drive that was never
  // there, which the route used to relay as a 200 saying `deleted: false` — a failure that reads as a
  // success. DELETE on a workspace answers 404, and so does this.
  it("refuses a drive that does not exist instead of reporting deleted: false", async () => {
    await expect(deleteDrive("gone", deps())).rejects.toThrowError(notFound);
  });
});

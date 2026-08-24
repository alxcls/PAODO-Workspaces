// The drive registry is the retry handle for deletion, so the store removes it only after files and
// connections are gone. This route-level boundary pins the public half of that contract: a cleanup
// failure is a 500, never the same success receipt as a completed deletion.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  deleteDrive: vi.fn(),
}));

vi.mock("@/lib/operations/drives/manage", () => ({
  deleteDrive: h.deleteDrive,
  getDrive: vi.fn(),
  updateDrive: vi.fn(),
}));

import { DELETE } from "./route";

const DRIVE_ID = "9841ce91-f521-4ddf-a966-fa5b612167bf";
const request = () => new Request(`http://x/api/drives/${DRIVE_ID}`, { method: "DELETE" }) as never;
const ctx = { params: Promise.resolve({ id: DRIVE_ID }) };

beforeEach(() => {
  h.deleteDrive.mockReset().mockResolvedValue({ deleted: true });
});

describe("DELETE /api/drives/[id]", () => {
  it("returns success only after the deletion operation completes", async () => {
    const response = await DELETE(request(), ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: true });
  });

  it("returns a failure rather than deleted:true when cleanup fails", async () => {
    h.deleteDrive.mockRejectedValue(new Error("filesystem unavailable"));

    const response = await DELETE(request(), ctx);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
      error: "failed to delete drive",
    });
  });
});

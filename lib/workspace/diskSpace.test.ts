// checkFreeSpace is the only thing standing between a large upload and a full disk, so the math
// (bavail * bsize vs needed + reserved) is pinned directly against a mocked fs.statfs rather than
// relying on the real filesystem's free space, which the test can't control.

import { describe, it, expect, vi } from "vitest";

const statfs = vi.fn();
vi.mock("fs/promises", () => ({ default: { statfs: (...args: unknown[]) => statfs(...args) } }));

import { checkFreeSpace, requireFreeSpace, RESERVED_FREE_BYTES } from "./diskSpace";

describe("checkFreeSpace", () => {
  it("reports ok when free space covers the need plus reserve", async () => {
    statfs.mockResolvedValue({ bavail: 1000, bsize: 1024 });
    const result = await checkFreeSpace("/data", 500 * 1024, 400 * 1024);
    expect(result).toEqual({ ok: true, freeBytes: 1000 * 1024 });
  });

  it("reports not ok when free space is short of need plus reserve", async () => {
    statfs.mockResolvedValue({ bavail: 1000, bsize: 1024 });
    const result = await checkFreeSpace("/data", 700 * 1024, 400 * 1024);
    expect(result).toEqual({ ok: false, freeBytes: 1000 * 1024 });
  });

  it("treats exactly enough space as ok", async () => {
    statfs.mockResolvedValue({ bavail: 900, bsize: 1024 });
    const result = await checkFreeSpace("/data", 500 * 1024, 400 * 1024);
    expect(result.ok).toBe(true);
  });
});

describe("requireFreeSpace", () => {
  it("returns null when there is enough room, against the shared RESERVED_FREE_BYTES reserve", async () => {
    statfs.mockResolvedValue({ bavail: RESERVED_FREE_BYTES / 1024 + 1024, bsize: 1024 });
    expect(await requireFreeSpace("/data", 1024)).toBeNull();
  });

  it("returns a ready-to-return tool error string when short of room", async () => {
    statfs.mockResolvedValue({ bavail: 1, bsize: 1 });
    expect(await requireFreeSpace("/data", RESERVED_FREE_BYTES)).toBe(
      "Error: not enough free disk space to write this file.",
    );
  });
});

// checkFreeSpace is the only thing standing between a large upload and a full disk, so the math
// (bavail * bsize vs needed + reserved) is pinned directly against a mocked fs.statfs rather than
// relying on the real filesystem's free space, which the test can't control.

import { describe, it, expect, vi } from "vitest";

const statfs = vi.fn();
vi.mock("fs/promises", () => ({ default: { statfs: (...args: unknown[]) => statfs(...args) } }));

import { checkFreeSpace } from "./diskSpace";

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

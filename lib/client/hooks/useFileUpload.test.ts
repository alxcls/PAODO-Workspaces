// runUploadQueue is the per-file core of the folder-upload UX: every file is attempted on its own, so
// one file that can't upload — over-size (413), a server error (500/507), or a network drop — only
// ever costs that one file, never the rest of the drop. A 429 is real backpressure and is retried.
// fetch is mocked so every scenario is deterministic and no real network/server is involved.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runUploadQueue, type PathedFile } from "./useFileUpload";

const entry = (name: string): PathedFile => ({ file: new File(["x"], name), path: name });

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("runUploadQueue", () => {
  it("uploads every file when every request succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { ok: true })),
    );

    const result = await runUploadQueue([entry("a.txt"), entry("b.txt"), entry("c.txt")], { apiBase: "/api/x" });

    expect(result).toEqual({ uploaded: 3, notUploaded: [], overLimit: [], errorSummary: null });
  });

  it("skips a 413 and keeps draining the rest of the queue", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("big.bin")) return jsonResponse(413, { error: "File is 2 GB, which is over the 1 GB limit." });
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runUploadQueue([entry("a.txt"), entry("big.bin"), entry("c.txt")], { apiBase: "/api/x" });

    expect(result.uploaded).toBe(2);
    expect(result.notUploaded).toEqual(["big.bin"]);
    expect(result.overLimit).toEqual(["big.bin"]);
    // A 413 is a size skip, not an error — nothing to explain in errorSummary.
    expect(result.errorSummary).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("skips a 500 on one file and still uploads every other file", async () => {
    // The bug this replaces: a single non-413 failure used to abort the batch, so a whole folder was
    // dropped over one bad file. Now the failing file is set aside and the rest all go up.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("broken.txt")) return jsonResponse(500, { error: "internal error" });
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const entries = Array.from({ length: 10 }, (_, i) => entry(`file-${i}.txt`)).concat(entry("broken.txt"));
    const result = await runUploadQueue(entries, { apiBase: "/api/x" });

    expect(result.uploaded).toBe(10);
    expect(result.notUploaded).toEqual(["broken.txt"]);
    expect(result.errorSummary).toBe("internal error");
    // Every file was attempted exactly once — nothing was abandoned in the queue.
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("records a 507 with its reason but keeps draining the rest", async () => {
    // Even a disk-full 507 no longer aborts: it's recorded per-file (with its message surfaced for
    // context) and the queue keeps going, so nothing is silently dropped on its account.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("nope.bin"))
        return jsonResponse(507, { error: "Not enough free disk space to accept this upload." });
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runUploadQueue([entry("a.txt"), entry("nope.bin"), entry("c.txt")], { apiBase: "/api/x" });

    expect(result.uploaded).toBe(2);
    expect(result.notUploaded).toEqual(["nope.bin"]);
    expect(result.errorSummary).toContain("Not enough free disk space");
  });

  it("records a network drop on one file and still uploads the rest", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("dropped.txt")) throw new TypeError("network error");
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runUploadQueue([entry("a.txt"), entry("dropped.txt"), entry("c.txt")], { apiBase: "/api/x" });

    expect(result.uploaded).toBe(2);
    expect(result.notUploaded).toEqual(["dropped.txt"]);
    expect(result.errorSummary).toContain("could not be uploaded");
  });

  it("tracks a 413 in overLimit and a sibling 500 in notUploaded, both fully accounted for", async () => {
    // Two files fail different ways in the same run: one over-size (413, → overLimit) and one server
    // error (500). Both land in notUploaded, but only the 413 belongs in overLimit.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("big.bin")) return jsonResponse(413, { error: "File is 2 GB, which is over the 1 GB limit." });
      if (url.includes("broken.txt")) return jsonResponse(500, { error: "internal error" });
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runUploadQueue([entry("big.bin"), entry("broken.txt"), entry("ok.txt")], { apiBase: "/api/x" });

    expect(result.uploaded).toBe(1);
    expect(result.overLimit).toEqual(["big.bin"]);
    expect(new Set(result.notUploaded)).toEqual(new Set(["big.bin", "broken.txt"]));
    expect(result.errorSummary).toBe("internal error");
  });

  it("retries a 429 honoring Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls += 1;
        // retry-after: 0 falls back to the 1s default wait (see the `retryAfter > 0` check) —
        // fake timers let that wait resolve instantly instead of costing a real second per test run.
        if (calls === 1) return jsonResponse(429, { error: "rate limited" }, { "retry-after": "0" });
        return jsonResponse(200, { ok: true });
      });
      vi.stubGlobal("fetch", fetchMock);

      const resultP = runUploadQueue([entry("a.txt")], { apiBase: "/api/x" });
      await vi.runAllTimersAsync();
      const result = await resultP;

      expect(result).toEqual({ uploaded: 1, notUploaded: [], overLimit: [], errorSummary: null });
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports progress as files land", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { ok: true })),
    );
    const progress: number[] = [];

    await runUploadQueue([entry("a.txt"), entry("b.txt")], { apiBase: "/api/x", onProgress: (n) => progress.push(n) });

    expect(progress).toEqual([1, 2]);
  });
});

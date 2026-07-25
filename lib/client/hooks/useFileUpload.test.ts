// runUploadQueue is the skip-vs-abort core of the folder-upload UX: an individually-oversized file
// (413) must not cost the rest of a large batch, while a systemic failure (507, 400, 500, network)
// still has to stop the remaining queue — pressing on past a full disk or a broken path would just
// bury the real cause under a pile of consequential errors. fetch is mocked so every scenario is
// deterministic and no real network/server is involved.

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

    expect(result).toEqual({ uploaded: 3, notUploaded: [], hardFailure: null });
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
    expect(result.hardFailure).toBeNull();
    // Every file was still attempted — a 413 never aborts the controller.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports a systemic failure (507) as hardFailure and lists the failing path in notUploaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(507, { error: "Not enough free disk space to accept this upload." })),
    );

    // A single-entry queue keeps this deterministic (no concurrency ambiguity about which of
    // several in-flight requests "wins"): the one request that runs fails systemically.
    const result = await runUploadQueue([entry("a.txt")], { apiBase: "/api/x" });

    expect(result.hardFailure).toContain("Not enough free disk space");
    expect(result.uploaded).toBe(0);
    expect(result.notUploaded).toEqual(["a.txt"]);
  });

  it("lists every never-attempted file left in the queue when a systemic failure aborts the batch", async () => {
    // A queue larger than CONCURRENCY (6): the first worker's failure aborts before the later
    // entries are ever dequeued, so they must show up in notUploaded even though no request was
    // ever sent for them.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { error: "internal error" })),
    );

    const entries = Array.from({ length: 10 }, (_, i) => entry(`file-${i}.txt`));
    const result = await runUploadQueue(entries, { apiBase: "/api/x" });

    expect(result.hardFailure).toBeTruthy();
    // Every entry is accounted for in notUploaded — either it was the one that failed, or it was
    // still sitting in the queue when the abort fired.
    expect(new Set(result.notUploaded)).toEqual(new Set(entries.map((e) => e.path)));
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

      expect(result).toEqual({ uploaded: 1, notUploaded: [], hardFailure: null });
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

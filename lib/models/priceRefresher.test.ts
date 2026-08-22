// The refresher's job is to keep the LIVE rate table current without a redeploy, and — just as
// importantly — to never make pricing worse than it already is. A failed fetch, an unwritable cache
// or a corrupt cache file must all leave the previous rates in force, because the alternative
// (pricing every model as unknown, or crashing the boot path) is worse than a slightly old rate.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";

// vi.mock is hoisted above the imports, so the temp root has to be created in a hoisted block too.
const { ROOT } = vi.hoisted(() => {
  const { mkdtempSync } = require("fs") as typeof import("fs");
  const { tmpdir } = require("os") as typeof import("os");
  const { join } = require("path") as typeof import("path");
  return { ROOT: mkdtempSync(join(tmpdir(), "price-refresher-")) };
});

vi.mock("../infra/paths", () => ({ WORKSPACES_ROOT: ROOT }));
vi.mock("./refresh", () => ({ buildCatalog: vi.fn() }));

import { buildCatalog } from "./refresh";
import { getRate, getCatalog, setCatalog } from "./pricing";
import { _tick, _loadCached, _CACHE_FILE, startPriceRefresher, stopPriceRefresher } from "./priceRefresher";

const build = vi.mocked(buildCatalog);

const entry = (input: number, output: number) => ({
  provider: "openai",
  source: "litellm" as const,
  input_cost_per_token: input,
  output_cost_per_token: output,
});

// A healthy build result, so each test states only the field it is about. Every report buildCatalog
// carries must be defaulted here, or a new one reads as "nothing to report" in tests that never said so.
const built = (over: Partial<Awaited<ReturnType<typeof buildCatalog>>> = {}) => ({
  catalog: {},
  filled: [],
  scaleway: [],
  unpriced: [],
  effortDrift: [],
  sourceFailures: [],
  ...over,
});

let seeded: ReturnType<typeof getCatalog>;

beforeEach(() => {
  seeded = getCatalog();
  build.mockReset();
  if (existsSync(_CACHE_FILE)) rmSync(_CACHE_FILE);
});

afterEach(() => {
  setCatalog(seeded); // the catalog is process-global; leaking a test's rates would poison the rest
});

describe("priceRefresher", () => {
  it("makes a fetched rate the one getRate returns", async () => {
    expect(getRate("brand-new-model")).toBeUndefined();
    build.mockResolvedValue(built({ catalog: { "brand-new-model": entry(1e-6, 2e-6) } }));

    await _tick();

    expect(getRate("brand-new-model")).toEqual({
      input: 1e-6,
      cachedInput: 1e-6,
      cacheCreation: 1e-6,
      output: 2e-6,
      // An entry with no currency is dollars — what both bulk lists quote, and what every rate
      // vendored before Scaleway arrived actually was.
      currency: "USD",
    });
  });

  it("replaces rates wholesale rather than merging, so a repriced model does not keep its old rate", async () => {
    setCatalog({ "gpt-x": entry(9e-6, 9e-6) });
    build.mockResolvedValue(built({ catalog: { "gpt-x": entry(1e-6, 1e-6) } }));

    await _tick();

    expect(getRate("gpt-x")!.input).toBe(1e-6);
  });

  it("caches the fetched catalog so the next boot starts current instead of on the vendored seed", async () => {
    build.mockResolvedValue(built({ catalog: { "gpt-x": entry(3e-6, 6e-6) } }));

    await _tick();

    expect(JSON.parse(readFileSync(_CACHE_FILE, "utf8"))).toEqual({ "gpt-x": entry(3e-6, 6e-6) });
  });

  // The whole point of freezing cost at write time is that a wrong rate is unrecoverable. Falling
  // back to "no rates" on a network blip would record a run of costless turns we can never restate.
  it("keeps the rates already in force when the fetch fails", async () => {
    setCatalog({ "gpt-x": entry(5e-6, 5e-6) });
    build.mockRejectedValue(new Error("upstream down"));

    await expect(_tick()).resolves.toBeUndefined();

    expect(getRate("gpt-x")!.input).toBe(5e-6);
  });

  it("still applies fetched rates when the cache cannot be written", async () => {
    // A directory where the cache file should go makes the write fail without touching the fetch.
    rmSync(_CACHE_FILE, { force: true });
    const asDir = _CACHE_FILE;
    mkdirSync(asDir, { recursive: true });
    build.mockResolvedValue(built({ catalog: { "gpt-x": entry(7e-6, 7e-6) } }));

    await _tick();

    expect(getRate("gpt-x")!.input).toBe(7e-6);
    rmSync(asDir, { recursive: true, force: true });
  });

  /**
   * A source that cannot be reached is the nastiest case, because buildCatalog still RESOLVES: the
   * tick looks successful, and the wholesale swap then deletes rates the process was already holding.
   * Turns on those models freeze cost `undefined`, which no later refresh can restate — so a partial
   * refresh has to end up strictly no worse than not refreshing at all.
   */
  describe("when one source is unreachable", () => {
    const scaleway = (input: number) => ({
      provider: "scaleway",
      source: "scaleway" as const,
      currency: "EUR" as const,
      input_cost_per_token: input,
      output_cost_per_token: input * 2,
    });

    it("carries the missing source's previous rates forward instead of dropping them", async () => {
      setCatalog({ "qwen3.6-35b-a3b": scaleway(2.5e-7), "gpt-x": entry(5e-6, 5e-6) });
      build.mockResolvedValue(built({ catalog: { "gpt-x": entry(1e-6, 1e-6) }, sourceFailures: ["scaleway"] }));

      await _tick();

      expect(getRate("qwen3.6-35b-a3b")).toMatchObject({ input: 2.5e-7, currency: "EUR" });
      // The sources that DID answer still replace wholesale — this is a hole-filler, not a merge.
      expect(getRate("gpt-x")!.input).toBe(1e-6);
    });

    it("persists the carried rates too, so a restart does not reopen the hole", async () => {
      setCatalog({ "qwen3.6-35b-a3b": scaleway(2.5e-7) });
      build.mockResolvedValue(built({ catalog: { "gpt-x": entry(1e-6, 1e-6) }, sourceFailures: ["scaleway"] }));

      await _tick();

      expect(Object.keys(JSON.parse(readFileSync(_CACHE_FILE, "utf8")))).toContain("qwen3.6-35b-a3b");
    });

    // The narrowing that keeps this from becoming the merge setCatalog exists to prevent: a model the
    // app no longer offers must stay gone, however recently its rate was in force.
    it("does not resurrect a model that is no longer offered", async () => {
      setCatalog({ "retired-scaleway-model": scaleway(9e-7) });
      build.mockResolvedValue(built({ sourceFailures: ["scaleway"] }));

      await _tick();

      expect(getRate("retired-scaleway-model")).toBeUndefined();
    });

    // The other half of the same bug: a partial refresh returned early, skipping the retry a hard
    // failure schedules — so the hole stayed a full day for a source that may have been back in minutes.
    it("schedules the sooner retry rather than waiting out the full interval", async () => {
      vi.useFakeTimers();
      try {
        build.mockResolvedValue(built({ sourceFailures: ["scaleway"] }));
        startPriceRefresher();
        await vi.advanceTimersByTimeAsync(0);
        expect(build).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(build).toHaveBeenCalledTimes(2);
      } finally {
        stopPriceRefresher();
        vi.useRealTimers();
      }
    });

    it("leaves a healthy source's models alone when nothing failed", async () => {
      setCatalog({ "qwen3.6-35b-a3b": scaleway(2.5e-7) });
      build.mockResolvedValue(built({ catalog: { "gpt-x": entry(1e-6, 1e-6) } }));

      await _tick();

      // No failure to compensate for: a model genuinely dropped upstream has to disappear.
      expect(getRate("qwen3.6-35b-a3b")).toBeUndefined();
    });
  });

  it("adopts a cached catalog at boot", () => {
    writeFileSync(_CACHE_FILE, JSON.stringify({ "cached-model": entry(4e-6, 8e-6) }));

    expect(_loadCached()).toBe(true);
    expect(getRate("cached-model")!.input).toBe(4e-6);
  });

  it("keeps the vendored seed when there is no cache yet", () => {
    expect(_loadCached()).toBe(false);
    expect(getRate("deepseek-v4-pro")).toBeDefined();
  });

  it.each([
    ["corrupt", "{not json"],
    ["empty", "{}"],
  ])("keeps the vendored seed when the cache is %s", (_label, contents) => {
    writeFileSync(_CACHE_FILE, contents);

    expect(_loadCached()).toBe(false);
    // An adopted empty/corrupt cache would price every model as unknown — worse than a stale seed.
    expect(getRate("deepseek-v4-pro")).toBeDefined();
  });
});

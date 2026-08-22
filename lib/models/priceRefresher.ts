// Keeps the live rate table current in the running server, so nobody has to remember to run
// `npm run update-pricing` and redeploy.
//
// Why this has to happen in the live process rather than at build time: a turn's USD cost is frozen
// when the turn is written (lib/usage/record.ts), so a rate that has gone stale is not a display bug
// a later refresh repairs — it is permanently wrong in the database. Every hour the app runs on a
// stale rate produces records that can never be corrected. The vendored ./model-pricing.json is only
// a seed for the very first boot.
//
// Follows the same in-process tick convention as scheduler.ts, proxyReconciler.ts and
// uploads/sweeper.ts: a globalSingleton timer, unref'd so it never holds the process open, with an
// in-flight guard so a slow tick can't overlap the next one.
//
// Failures are logged and swallowed. A refresh that cannot reach the network leaves the previous
// rates in force, which is the correct outcome — pricing must never be able to take the app down.
import { writeFileSync, readFileSync, renameSync } from "fs";
import path from "path";
import { createLogger } from "../infra/logger";
import { globalSingleton } from "../infra/globalSingleton";
import { WORKSPACES_ROOT } from "../infra/paths";
import { buildCatalog, type Catalog, type VendoredEntry } from "./refresh";
import { getCatalog, setCatalog } from "./pricing";
import { offeredModelIds } from "./registry";

const log = createLogger("priceRefresher");

const DEFAULT_TICK_MS = 24 * 60 * 60_000;
// A failed fetch would otherwise leave the app on the old rates for a full day. Retry sooner, but
// not so often that a sustained upstream outage becomes a request flood.
const RETRY_MS = 30 * 60_000;

// Lives on the data volume, which survives a redeploy — so a restart comes back on the rates last
// fetched rather than falling back to whatever the image was built with. This is deliberately NOT
// the vendored lib/models/model-pricing.json: that file is source, tracked in git, and read-only at
// runtime in the container.
//
// Dot-prefixed like every other app-owned file in this root (.workspaces.json, .cron-schedules.json,
// .paodo.db, …). That convention is load-bearing: workspace directories are plain joins of the root
// and a workspace id, so an undotted name shares a namespace with them.
const CACHE_FILE = path.join(WORKSPACES_ROOT, ".model-pricing-cache.json");

type RefresherState = { timer: NodeJS.Timeout | null; retryTimer: NodeJS.Timeout | null; running: boolean };
const state = globalSingleton<RefresherState>("priceRefresherState", () => ({
  timer: null,
  retryTimer: null,
  running: false,
}));

// Atomic: a torn write here would be read back at next boot as a corrupt catalog, and an unparseable
// cache means every model prices as "unknown" until the first successful fetch.
function persist(catalog: Catalog): void {
  const tmp = `${CACHE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(catalog, null, 2) + "\n");
  renameSync(tmp, CACHE_FILE);
}

/**
 * Adopt the last successfully fetched catalog, if there is one. Synchronous and called before the
 * server listens, so no request can be priced from the stale seed while the first fetch is in
 * flight. A missing or unreadable cache is normal (first boot) and simply leaves the seed in place.
 */
function loadCached(): boolean {
  let raw: string;
  try {
    raw = readFileSync(CACHE_FILE, "utf8");
  } catch {
    return false; // no cache yet — first boot on this volume
  }
  try {
    const parsed = JSON.parse(raw) as Catalog;
    const count = Object.keys(parsed).length;
    // A parseable-but-empty cache would price every model as unknown. Prefer the seed.
    if (count === 0) throw new Error("cached catalog is empty");
    setCatalog(parsed);
    log.info({ event: "price_cache_loaded", models: count, filePath: CACHE_FILE }, "loaded cached model prices");
    return true;
  } catch (err) {
    log.warn(
      { event: "price_cache_unreadable", err, filePath: CACHE_FILE },
      "cached model prices could not be read — falling back to the vendored seed",
    );
    return false;
  }
}

/**
 * Put back the rates a source that could not deliver a complete response would have supplied.
 *
 * `setCatalog` is otherwise wholesale, and must stay that way: merging by default would keep a rate
 * for a model upstream has dropped, which is the stale-rate failure this whole file exists to end.
 * This is the one exception, kept narrow enough that it cannot cause that. It only fills keys the new
 * catalog does NOT have (a fresh rate always wins), only from the sources that actually failed, and
 * only for models still offered — so it can never resurrect a retired model, and it stops happening
 * the moment the source answers again.
 *
 * Without it, a transient outage is worse than a total one: `buildCatalog` still returns, the tick
 * counts as success, and the wholesale swap DELETES rates the process was already holding. Every turn
 * on those models then freezes cost `undefined` (lib/usage/record.ts), which no later refresh repairs.
 */
function carryForward(catalog: Catalog, failedSources: readonly VendoredEntry["source"][]): string[] {
  const offered = new Set(offeredModelIds());
  const carried: string[] = [];
  for (const [model, entry] of Object.entries(getCatalog())) {
    // Matching the string against the known source names is also what narrows it: the live catalog
    // can come from a cache file, so its `source` is only a string until one of these claims it.
    const source = failedSources.find((failed) => failed === entry.source);
    if (!source || model in catalog || !offered.has(model)) continue;
    catalog[model] = { ...entry, source };
    carried.push(model);
  }
  return carried;
}

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  // Any outcome leaving the catalog short of a healthy fetch. A partial refresh used to return early
  // and skip the retry below — the same gap as a hard failure, but reported as success.
  let retry = false;
  try {
    const { catalog, filled, unpriced, sourceFailures } = await buildCatalog();

    if (sourceFailures.length) {
      retry = true;
      const carried = carryForward(catalog, sourceFailures);
      log.warn(
        { event: "price_source_incomplete", sources: sourceFailures, carried, retryMs: RETRY_MS },
        "a price source was incomplete or unreachable — carrying its previous rates forward",
      );
    }

    setCatalog(catalog);
    try {
      persist(catalog);
    } catch (err) {
      // The fetch succeeded and the live rates are already updated — a cache we couldn't write only
      // costs us the head start at next boot, so this must not fail the tick.
      log.warn({ event: "price_cache_write_failed", err, filePath: CACHE_FILE }, "could not cache model prices");
    }
    // Unpriced offered models cost "unknown" rather than a wrong number, so this is a warning and
    // not a reason to reject the refresh — but it does mean usage for those models records no cost.
    if (unpriced.length) {
      log.warn(
        { event: "price_refresh_unpriced_models", models: unpriced },
        "no upstream rate for offered model(s) — their usage will record no cost",
      );
    }
    log.info(
      { event: "price_refresh_completed", outcome: "prices_updated", models: Object.keys(catalog).length, filled },
      "model prices refreshed",
    );
  } catch (err) {
    retry = true;
    log.warn(
      { event: "price_refresh_failed", outcome: "previous_prices_retained", err, retryMs: RETRY_MS },
      "model price refresh failed — keeping the rates already in force",
    );
  } finally {
    state.running = false;
  }
  // Reached on a failed OR a partial refresh. One pending retry at a time; the interval keeps running.
  if (retry && state.timer && !state.retryTimer) {
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      void tick();
    }, RETRY_MS);
    state.retryTimer.unref?.();
  }
}

/** Start the refresh loop, priming from cache and fetching once at boot. Idempotent. */
export function startPriceRefresher(): void {
  if (state.timer) return;
  loadCached();
  const configured = Number(process.env.PRICE_REFRESH_TICK_MS);
  const tickMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TICK_MS;
  state.timer = setInterval(tick, tickMs);
  state.timer.unref?.();
  log.info({ event: "price_refresher_started", tickMs }, "price refresher started");
  // Fetch immediately rather than waiting a full interval: on a fresh volume the seed can be months
  // old. Not awaited — a slow or unreachable upstream must never delay the server coming up.
  void tick();
}

export function stopPriceRefresher(): void {
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  log.info({ event: "price_refresher_stopped" }, "price refresher stopped");
}

// Exported for tests to drive a single refresh deterministically.
export { tick as _tick, loadCached as _loadCached, CACHE_FILE as _CACHE_FILE };

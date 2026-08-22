/**
 * Builds the model-pricing catalog from the public price lists. This is the ONE implementation of
 * "what are the current rates" — both consumers import it:
 *   - scripts/update-pricing.ts, which vendors the result into ./model-pricing.json at author time
 *   - ./priceRefresher.ts, which swaps the result into the live catalog on a timer in production
 * Keeping it in one place is the point: a second copy of the provider filter or the key-prefix rules
 * would drift, and a drifted rate is exactly the bug this file exists to prevent.
 *
 * ONE BULK SOURCE, THEN NARROWER ONES THAT ONLY FILL WHAT IT MISSED:
 *   1. LiteLLM — the bulk source. Its file carries ~3000 models across every provider; we keep only
 *      the providers this app supports and only the fields the cost math needs. Its breadth is what
 *      keeps RETIRED models priced, which matters because a turn's cost is frozen from this data at
 *      write time (lib/usage/record.ts).
 *   2. Scaleway's public product catalog — the VENDOR'S OWN billing feed, so it is authoritative
 *      rather than a third-party transcription, and it is the only source that carries Scaleway's
 *      cached-input rate. Unauthenticated. Fetched only while a Scaleway model is offered.
 *   3. models.dev — fetched ONLY when the steps above left an offered model with no rate. LiteLLM
 *      can lag a launch by weeks (it had no kimi-k3 six days after release); models.dev had it on
 *      day 0 and is keyed by bare model id, exactly what the app stores and looks up.
 * Each entry records which source it came from so a reviewer can tell at a glance.
 *
 * EVERY RATE CARRIES ITS CURRENCY. Scaleway prices in euros, and converting at refresh time would
 * bake a moving exchange rate into a cost that lib/usage/record.ts then freezes forever. So a euro
 * rate stays a euro rate end to end, and the dashboard renders whichever currency it was billed in.
 */
import { AVAILABLE_MODELS, offeredModelIds } from "./registry";
import { SCALEWAY_MODEL_EFFORTS } from "./scalewayEfforts";
import type { Currency } from "./currency";

const LITELLM_SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV_SOURCE = "https://models.dev/api.json";
const SCALEWAY_CATALOG_SOURCE = "https://api.scaleway.com/product-catalog/v2alpha1/public-catalog/products";

// The catalog prices every Scaleway product, ~5.5k rows, and ignores unknown filter params — so the
// Generative APIs rows can only be reached by paging the whole thing. Bounded to keep a loop finite.
const SCALEWAY_PAGE_SIZE = 1000;
const SCALEWAY_MAX_PAGES = 20;

// The region api.scaleway.ai serves, and the one the sovereignty claim rests on. Pinned rather than
// taking any region, so prices that diverge per region can't be silently averaged into one number.
const SCALEWAY_REGION = "fr-par";

// LiteLLM's provider ids for the providers this app supports (lib/agent/buildModel.ts). Moonshot is
// absent on purpose: LiteLLM keys its Moonshot models "moonshot/kimi-…", and the app looks rates up
// by the bare id it sends to the API, so those rows would never resolve. models.dev supplies them.
const PROVIDERS = new Set(["anthropic", "openai", "deepseek", "mistral"]);

// Providers whose LiteLLM rows are keyed "<provider>/<model>" rather than by the bare model id.
// Their rates are vendored under the bare tail so lookup() in ./pricing.ts — which only tries the id
// as given, then its tail, never a prefixed form — can actually find them.
//
// This is the same mismatch that keeps Moonshot on models.dev, and Moonshot could move here too;
// it deliberately hasn't, because that would reprice a model already shipping on a models.dev rate.
// Mistral has no such history, so its prefixed LiteLLM rows are safe to normalize.
const LITELLM_PREFIXED = new Set(["mistral"]);

/**
 * App provider id → models.dev provider id, for the fallback lookup. A provider added to
 * buildModel.ts wants an entry here too, or its models can only ever be priced by LiteLLM.
 *
 * Scaleway is deliberately ABSENT from this map and from PROVIDERS above. LiteLLM keys it three
 * segments deep ("scaleway/mistralai/pixtral-12b-2409"), which collides with the direct Mistral rows
 * once de-prefixed; and models.dev lists its models with the euro figures presented as dollars. Its
 * own catalog is both correct and currency-labelled, so it is the only source allowed to price it.
 */
const MODELS_DEV_PROVIDER: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  deepseek: "deepseek",
  moonshot: "moonshotai",
};

// A hung fetch would otherwise strand the refresher's in-flight guard set forever, silently killing
// every later tick — the loop would look alive and never fetch again.
const FETCH_TIMEOUT_MS = 30_000;

interface LiteLLMEntry {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

// models.dev quotes USD per MILLION tokens (LiteLLM quotes per token), hence the /1e6 below.
interface ModelsDevEntry {
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}
interface ModelsDevProvider {
  models?: Record<string, ModelsDevEntry>;
}

/**
 * One row of Scaleway's public product catalog. A row is a single metric for a single model —
 * "deepseek-v4-flash-0731 - input cached token - realtime - fr-par" — so a model spans several.
 *
 * `price` is absent on retired products, which is why every read of it is guarded.
 */
interface ScalewayProduct {
  sku?: string;
  product?: string;
  product_category?: string;
  locality?: { region?: string };
  unit_of_measure?: { unit?: string; size?: number };
  price?: { retail_price?: { currency_code?: string; units?: number; nanos?: number } };
  properties?: { generative_apis?: { supported_reasoning_values?: string[]; default_reasoning_value?: string } };
}

export interface VendoredEntry {
  provider: string;
  source: "litellm" | "models.dev" | "scaleway";
  /** Omitted means USD, which both bulk lists quote in. Present and "EUR" for Scaleway's own feed. */
  currency?: Currency;
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

export type Catalog = Record<string, VendoredEntry>;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch failed for ${url}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

// Mirrors lookup() in ./pricing.ts: the id as given, then its bare tail. Keeping these in step is
// what makes the "does every offered model price?" check below meaningful.
function resolves(catalog: Catalog, modelId: string): boolean {
  return Boolean(catalog[modelId] ?? catalog[modelId.split("/").pop() ?? modelId]);
}

export function fromLiteLLM(upstream: Record<string, LiteLLMEntry>): Catalog {
  const out: Catalog = {};
  for (const [id, e] of Object.entries(upstream)) {
    if (!e.litellm_provider || !PROVIDERS.has(e.litellm_provider)) continue;
    // Skip models with no usable rate (some catalog rows are context-window-only).
    if (typeof e.input_cost_per_token !== "number" || typeof e.output_cost_per_token !== "number") continue;
    const key = LITELLM_PREFIXED.has(e.litellm_provider) ? (id.split("/").pop() ?? id) : id;
    // A de-prefixed key must never displace a row already vendored under that bare name: the whole
    // point of the bare key is that the app looks rates up by it, so a collision would silently bill
    // one vendor's model at another's rate. First writer wins and the loser is simply not vendored.
    if (key !== id && out[key]) continue;
    out[key] = {
      provider: e.litellm_provider,
      source: "litellm",
      input_cost_per_token: e.input_cost_per_token,
      output_cost_per_token: e.output_cost_per_token,
      ...(typeof e.cache_read_input_token_cost === "number" && {
        cache_read_input_token_cost: e.cache_read_input_token_cost,
      }),
      ...(typeof e.cache_creation_input_token_cost === "number" && {
        cache_creation_input_token_cost: e.cache_creation_input_token_cost,
      }),
    };
  }

  // LiteLLM's Codestral alias can lag behind its versioned row. Price the maintained `-latest`
  // model from the newest version present so a refresh cannot restore the retired 24.05 rate.
  const newestCodestral = Object.keys(out)
    .filter((id) => /^codestral-\d{4}$/.test(id))
    .sort()
    .at(-1);
  if (newestCodestral) out["codestral-latest"] = { ...out[newestCodestral] };

  return out;
}

// Fills gaps for OFFERED models only — this is a fallback, not a second bulk import, so an
// unreleased-elsewhere model never sneaks into the file just because models.dev lists it.
export function fillGaps(catalog: Catalog, modelsDev: Record<string, ModelsDevProvider>): string[] {
  const filled: string[] = [];
  for (const [provider, entries] of Object.entries(AVAILABLE_MODELS)) {
    const devProvider = MODELS_DEV_PROVIDER[provider];
    if (!devProvider) continue;
    for (const model of entries) {
      if (resolves(catalog, model)) continue;
      const cost = modelsDev[devProvider]?.models?.[model]?.cost;
      if (typeof cost?.input !== "number" || typeof cost?.output !== "number") continue;
      catalog[model] = {
        provider,
        source: "models.dev",
        input_cost_per_token: cost.input / 1e6,
        output_cost_per_token: cost.output / 1e6,
        ...(typeof cost.cache_read === "number" && { cache_read_input_token_cost: cost.cache_read / 1e6 }),
        ...(typeof cost.cache_write === "number" && { cache_creation_input_token_cost: cost.cache_write / 1e6 }),
      };
      filled.push(model);
    }
  }
  return filled;
}

// A catalog row's price as a plain number of euros per token, or undefined when the row carries no
// usable price. `units` + `nanos` is Scaleway's decimal encoding; `size` is the tokens it covers.
function scalewayRate(row: ScalewayProduct): number | undefined {
  const retail = row.price?.retail_price;
  const size = row.unit_of_measure?.size;
  if (!retail || retail.currency_code !== "EUR") return undefined;
  if (row.unit_of_measure?.unit !== "token" || typeof size !== "number" || size <= 0) return undefined;
  return ((retail.units ?? 0) + (retail.nanos ?? 0) / 1e9) / size;
}

/**
 * Prices the OFFERED Scaleway models from the vendor's own catalog rows.
 *
 * Which metric a row carries is read off the SKU tail, not the human-readable variant string:
 * ".../deepseek_v4_flash_input_cached/fr-par" is stable in a way that " - input cached token - " is
 * not. Batch rows are skipped — they are a different API at half price, and billing a real-time call
 * at the batch rate would understate every turn.
 *
 * Rates are EUR per token, carried without conversion. See getRate in ./pricing.ts.
 */
export function fromScalewayCatalog(rows: readonly ScalewayProduct[]): Catalog {
  const offered = new Set(AVAILABLE_MODELS.scaleway ?? []);
  const metrics = new Map<string, { input?: number; output?: number; cacheRead?: number }>();

  for (const row of rows) {
    const model = row.product;
    if (!model || !offered.has(model)) continue;
    if (row.locality?.region !== SCALEWAY_REGION) continue;
    const sku = row.sku?.split("/").filter(Boolean).at(-2) ?? "";
    const rate = scalewayRate(row);
    if (rate === undefined || sku.endsWith("_batch")) continue;

    const entry = metrics.get(model) ?? {};
    if (sku.endsWith("_input_cached")) entry.cacheRead = rate;
    else if (sku.endsWith("_input")) entry.input = rate;
    else if (sku.endsWith("_output")) entry.output = rate;
    metrics.set(model, entry);
  }

  const out: Catalog = {};
  for (const [model, { input, output, cacheRead }] of metrics) {
    // Both halves or nothing: a model priced on input alone would bill every completion at zero.
    if (typeof input !== "number" || typeof output !== "number") continue;
    out[model] = {
      provider: "scaleway",
      source: "scaleway",
      currency: "EUR",
      input_cost_per_token: input,
      output_cost_per_token: output,
      ...(typeof cacheRead === "number" && { cache_read_input_token_cost: cacheRead }),
    };
  }
  return out;
}

/** Offered Scaleway models for which a catalog response did not provide a complete rate. */
export function missingOfferedScalewayModels(catalog: Catalog): string[] {
  return (AVAILABLE_MODELS.scaleway ?? []).filter((model) => !resolves(catalog, model));
}

/**
 * Offered Scaleway models whose documented reasoning levels no longer match ./scalewayEfforts.ts.
 *
 * That table is checked in rather than fetched, because it decides what the picker offers and what
 * validateMetadata accepts — see its header. This is the other half of that bargain: the same rows
 * the prices come from are re-read here, and `npm run update-pricing` fails on any disagreement, so
 * the transcription cannot quietly rot while the vendor moves on.
 *
 * A model with no rows carrying the field is not drift — that is an absent source, not a changed one.
 */
export function scalewayEffortDrift(rows: readonly ScalewayProduct[]): string[] {
  const offered = new Set(AVAILABLE_MODELS.scaleway ?? []);
  const drift: string[] = [];
  for (const model of offered) {
    const row = rows.find((r) => r.product === model && r.properties?.generative_apis?.supported_reasoning_values);
    const api = row?.properties?.generative_apis;
    if (!api?.supported_reasoning_values) continue;
    const known = SCALEWAY_MODEL_EFFORTS[model];
    const same =
      known &&
      known.fallback === api.default_reasoning_value &&
      [...known.supported].sort().join(",") === [...api.supported_reasoning_values].sort().join(",");
    if (!same) {
      drift.push(
        `${model}: catalog says [${api.supported_reasoning_values.join(", ")}] default ${api.default_reasoning_value}, ` +
          (known ? `table says [${known.supported.join(", ")}] default ${known.fallback}` : "table has no entry"),
      );
    }
  }
  return drift;
}

// Pages the whole catalog, since it takes no filter. Stops on an empty page or once total_count is
// covered, and is capped regardless so a changed contract cannot spin here forever.
async function fetchScalewayCatalog(): Promise<ScalewayProduct[]> {
  const rows: ScalewayProduct[] = [];
  for (let page = 1; page <= SCALEWAY_MAX_PAGES; page++) {
    const url = `${SCALEWAY_CATALOG_SOURCE}?page_size=${SCALEWAY_PAGE_SIZE}&page=${page}`;
    const body = await fetchJson<{ products?: ScalewayProduct[]; total_count?: number }>(url);
    const batch = body.products ?? [];
    rows.push(...batch);
    // Infinity, not 0: a contract change that drops total_count would otherwise satisfy this on page
    // one and stop, and the offered models' rows already span more than one page.
    if (batch.length < SCALEWAY_PAGE_SIZE || rows.length >= (body.total_count ?? Infinity)) break;
  }
  return rows;
}

export interface BuiltCatalog {
  catalog: Catalog;
  /** Offered models that only models.dev could price — LiteLLM hasn't published them yet. */
  filled: string[];
  /** Offered models priced from Scaleway's own catalog, in euros. */
  scaleway: string[];
  /** Offered models NO source prices. A non-empty list is a problem, not a normal outcome. */
  unpriced: string[];
  /** Descriptions of any Scaleway model whose documented effort levels have moved. Author-time only. */
  effortDrift: string[];
  /**
   * Sources that could not deliver a complete catalog, by `VendoredEntry.source`. A NARROWER source
   * is allowed to fail without failing the run — one vendor's outage or malformed response must not
   * throw away every other rate — but the result is then incomplete, and saying so is what stops a
   * caller mistaking it for a full catalog.
   *
   * The two callers disagree about what to do, exactly as they do about `unpriced`: the author-time
   * script refuses to vendor a partial file, while the refresher carries the missing source's
   * previous rates forward and retries sooner. Both are in the dark without this list.
   */
  sourceFailures: VendoredEntry["source"][];
}

/**
 * Fetch the price lists and assemble the catalog. Network-bound; throws if a BULK source is
 * unreachable. `unpriced` and `sourceFailures` are reported rather than thrown on, because the two
 * callers disagree about severity: the author-time script fails the run, while the production
 * refresher keeps the rates it already has (an unpriced model costs "unknown", which is survivable —
 * a wrong rate is not). Reported is not the same as ignored: a caller that drops `sourceFailures` on
 * the floor publishes a catalog with a hole in it as though the fetch had gone fine.
 *
 * Only Scaleway's own feed may price a Scaleway model. models.dev also lists some of them, but it
 * republishes the euro figures as though they were dollars; taking the vendor feed instead is what
 * makes the currency on those entries true rather than a label over a number that means something else.
 */
export async function buildCatalog(): Promise<BuiltCatalog> {
  const catalog = fromLiteLLM(await fetchJson<Record<string, LiteLLMEntry>>(LITELLM_SOURCE));

  // Before models.dev, so its dollar-labelled euro rows never win a Scaleway model. Fetched only
  // while Scaleway models are offered, and non-fatal but never silent — see `sourceFailures`.
  let scaleway: string[] = [];
  let effortDrift: string[] = [];
  const sourceFailures: VendoredEntry["source"][] = [];
  const offeredScaleway = AVAILABLE_MODELS.scaleway ?? [];
  if (offeredScaleway.length > 0) {
    // These ids belong to the Scaleway provider in this app. Remove any same-named LiteLLM row before
    // the vendor fetch so a partial response cannot leave a dollar rate from a different provider in
    // the hole; it must remain absent for carryForward to restore the previous Scaleway euro rate.
    for (const model of offeredScaleway) delete catalog[model];
    try {
      const rows = await fetchScalewayCatalog();
      const priced = fromScalewayCatalog(rows);
      Object.assign(catalog, priced);
      scaleway = Object.keys(priced);
      effortDrift = scalewayEffortDrift(rows);
      // HTTP 200 is not sufficient evidence of a healthy source: an empty page, a truncated page set,
      // or a response-shape change can all parse successfully while omitting an offered model. Mark
      // that outcome partial so the live refresher carries the missing known-good rates forward.
      if (missingOfferedScalewayModels(priced).length > 0) sourceFailures.push("scaleway");
    } catch {
      // Reported, never guessed at: a made-up euro rate would be frozen onto every turn. The caller
      // decides what an absent source means — see `sourceFailures`. Swallowing it silently would make
      // a catalog missing these rates look exactly like a successful refresh from here.
      sourceFailures.push("scaleway");
    }
  }

  // Only reach for models.dev if something is still short — see the header. A refresh where the
  // sources above cover everything never touches it, so it can be down without breaking anything.
  let filled: string[] = [];
  if (offeredModelIds().some((m) => !resolves(catalog, m))) {
    filled = fillGaps(catalog, await fetchJson<Record<string, ModelsDevProvider>>(MODELS_DEV_SOURCE));
  }

  // Sort by id for a stable, diff-friendly vendored file.
  const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  return {
    catalog: sorted,
    filled,
    scaleway,
    unpriced: offeredModelIds().filter((m) => !resolves(sorted, m)),
    effortDrift,
    sourceFailures,
  };
}

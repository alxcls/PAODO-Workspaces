// Builds the model-pricing catalog from the public price lists. This is the ONE implementation of
// "what are the current rates" — both consumers import it:
//   - scripts/update-pricing.ts, which vendors the result into ./model-pricing.json at author time
//   - ./priceRefresher.ts, which swaps the result into the live catalog on a timer in production
// Keeping it in one place is the point: a second copy of the provider filter or the key-prefix rules
// would drift, and a drifted rate is exactly the bug this file exists to prevent.
//
// ONE SOURCE, PLUS A CONDITIONAL FALLBACK:
//   1. LiteLLM — the bulk source, and the only one fetched on a normal run. Its file carries ~3000
//      models across every provider; we keep only the providers this app supports and only the
//      fields the cost math needs. Its breadth is what keeps RETIRED models priced, which matters
//      because a turn's cost is frozen from this data at write time (lib/usage/record.ts).
//   2. models.dev — fetched ONLY when step 1 left an offered model with no rate. LiteLLM can lag a
//      launch by weeks (it had no kimi-k3 six days after release); models.dev had it on day 0 and is
//      keyed by bare model id, exactly what the app stores and looks up. The moment LiteLLM catches
//      up on a model, this request stops happening at all.
// Each entry records which source it came from so a reviewer can tell at a glance.
import { AVAILABLE_MODELS, offeredModelIds } from "./registry";

const LITELLM_SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV_SOURCE = "https://models.dev/api.json";

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
// Mistral has no such history, and LiteLLM is the only source that carries its full catalog: models.dev
// is missing the entire Ministral 3 generation and prices labs-devstral-small-2512 at $0, which would
// silently report free runs — the one outcome ./pricing.ts exists to prevent.
const LITELLM_PREFIXED = new Set(["mistral"]);

// App provider id → models.dev provider id, for the fallback lookup. A provider added to
// buildModel.ts wants an entry here too, or its models can only ever be priced by LiteLLM.
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

export interface VendoredEntry {
  provider: string;
  source: "litellm" | "models.dev";
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
  return out;
}

// Fills gaps for OFFERED models only — this is a fallback, not a second bulk import, so an
// unreleased-elsewhere model never sneaks into the file just because models.dev lists it.
export function fillGaps(catalog: Catalog, modelsDev: Record<string, ModelsDevProvider>): string[] {
  const filled: string[] = [];
  for (const [provider, entries] of Object.entries(AVAILABLE_MODELS)) {
    const devProvider = MODELS_DEV_PROVIDER[provider];
    if (!devProvider) continue;
    for (const { id: model } of entries) {
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

export interface BuiltCatalog {
  catalog: Catalog;
  /** Offered models that only models.dev could price — LiteLLM hasn't published them yet. */
  filled: string[];
  /** Offered models NEITHER source prices. A non-empty list is a problem, not a normal outcome. */
  unpriced: string[];
}

/**
 * Fetch both price lists and assemble the catalog. Network-bound; throws if the bulk source is
 * unreachable. `unpriced` is reported rather than thrown on, because the two callers disagree about
 * severity: the author-time script fails the run, while the production refresher keeps the rates it
 * already has (an unpriced model costs "unknown", which is survivable — a wrong rate is not).
 */
export async function buildCatalog(): Promise<BuiltCatalog> {
  const catalog = fromLiteLLM(await fetchJson<Record<string, LiteLLMEntry>>(LITELLM_SOURCE));

  // Only reach for the second source if the first came up short — see the header. A refresh where
  // LiteLLM covers everything never touches models.dev, so it can be down without breaking anything.
  let filled: string[] = [];
  if (offeredModelIds().some((m) => !resolves(catalog, m))) {
    filled = fillGaps(catalog, await fetchJson<Record<string, ModelsDevProvider>>(MODELS_DEV_SOURCE));
  }

  // Sort by id for a stable, diff-friendly vendored file.
  const sorted = Object.fromEntries(Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  return { catalog: sorted, filled, unpriced: offeredModelIds().filter((m) => !resolves(sorted, m)) };
}

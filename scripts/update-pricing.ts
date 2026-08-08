// Refreshes the vendored model-pricing catalog (lib/models/model-pricing.json) from public price
// lists. This is the ONLY thing that touches the network for pricing — it runs manually
// (`npm run update-pricing`), never at request time. New models land in the app the next time this
// is run. See lib/models/pricing.ts for how the file is consumed.
//
// ONE SOURCE, PLUS A CONDITIONAL FALLBACK:
//   1. LiteLLM — the bulk source, and the only one fetched on a normal run. Its file carries ~3000
//      models across every provider; we keep only the providers this app supports and only the
//      fields the cost math needs, so the vendored file stays small and reviewable in a diff. Its
//      breadth is what keeps RETIRED models priced — cost is computed at read time from stored turn
//      records (lib/client/usageSessions.ts), so history depends on this file, not just the picker.
//   2. models.dev — fetched ONLY when step 1 left an offered model with no rate. LiteLLM can lag a
//      launch by weeks (it had no kimi-k3 six days after release); models.dev had it on day 0 and is
//      keyed by bare model id, exactly what the app stores and looks up. The moment LiteLLM catches
//      up on a model, this request stops happening at all.
// Both sources agreed to the cent on every model offered at the time this was written, so the
// fallback shifts no existing rate — it only fills holes. Each entry records which source it came
// from so a reviewer can tell at a glance.
//
// The run FAILS if any offered model still has no rate, because lib/models/registry.test.ts asserts
// every offered model prices — better to find out here than in CI.
//
// (The picker's model list is a separate code-owned catalog: lib/models/registry.ts.)
import { writeFileSync } from "fs";
import path from "path";
import { AVAILABLE_MODELS } from "../lib/models/registry";

const LITELLM_SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_DEV_SOURCE = "https://models.dev/api.json";

// LiteLLM's provider ids for the providers this app supports (lib/agent/buildModel.ts). Moonshot is
// absent on purpose: LiteLLM keys its Moonshot models "moonshot/kimi-…", and the app looks rates up
// by the bare id it sends to the API, so those rows would never resolve. models.dev supplies them.
const PROVIDERS = new Set(["anthropic", "openai", "deepseek"]);

// App provider id → models.dev provider id, for the fallback lookup. A provider added to
// buildModel.ts wants an entry here too, or its models can only ever be priced by LiteLLM.
const MODELS_DEV_PROVIDER: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  deepseek: "deepseek",
  moonshot: "moonshotai",
};

// Must stay in step with the `import catalog from "./model-pricing.json"` in lib/models/pricing.ts:
// writing anywhere else leaves the app on the old rates while this script reports success.
const OUT = path.join(__dirname, "..", "lib", "models", "model-pricing.json");

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

interface VendoredEntry {
  provider: string;
  source: "litellm" | "models.dev";
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${url}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

// Mirrors lookup() in lib/models/pricing.ts: the id as given, then its bare tail. Keeping
// these in step is what makes the "does every offered model price?" check below meaningful.
function resolves(catalog: Record<string, VendoredEntry>, modelId: string): boolean {
  return Boolean(catalog[modelId] ?? catalog[modelId.split("/").pop() ?? modelId]);
}

function fromLiteLLM(upstream: Record<string, LiteLLMEntry>): Record<string, VendoredEntry> {
  const out: Record<string, VendoredEntry> = {};
  for (const [id, e] of Object.entries(upstream)) {
    if (!e.litellm_provider || !PROVIDERS.has(e.litellm_provider)) continue;
    // Skip models with no usable rate (some catalog rows are context-window-only).
    if (typeof e.input_cost_per_token !== "number" || typeof e.output_cost_per_token !== "number") continue;
    out[id] = {
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
function fillGaps(catalog: Record<string, VendoredEntry>, modelsDev: Record<string, ModelsDevProvider>): string[] {
  const filled: string[] = [];
  for (const [provider, models] of Object.entries(AVAILABLE_MODELS)) {
    const devProvider = MODELS_DEV_PROVIDER[provider];
    if (!devProvider) continue;
    for (const model of models) {
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

const offeredModels = () => Object.values(AVAILABLE_MODELS).flat();

async function main() {
  const out = fromLiteLLM(await fetchJson<Record<string, LiteLLMEntry>>(LITELLM_SOURCE));

  // Only reach for the second source if the first came up short — see the header. A refresh where
  // LiteLLM covers everything never touches models.dev, so it can be down without breaking anything.
  let filled: string[] = [];
  const gaps = offeredModels().filter((m) => !resolves(out, m));
  if (gaps.length) {
    console.log(`no LiteLLM rate for ${gaps.join(", ")} — falling back to models.dev`);
    filled = fillGaps(out, await fetchJson<Record<string, ModelsDevProvider>>(MODELS_DEV_SOURCE));
  }

  // Sort by id for a stable, diff-friendly file.
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const unpriced = offeredModels().filter((m) => !resolves(sorted, m));

  writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`wrote ${Object.keys(sorted).length} models to ${path.relative(process.cwd(), OUT)}`);
  if (filled.length) console.log(`filled from models.dev (not yet in LiteLLM): ${filled.join(", ")}`);
  if (unpriced.length) {
    console.error(`\nNO RATE for offered model(s): ${unpriced.join(", ")}`);
    console.error("Neither source prices these. Retire them from lib/models/registry.ts or add a source.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

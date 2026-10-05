// LLM rates by model id, seeded from a vendored LiteLLM/models.dev list (`npm run update-pricing`). A turn's cost is
// frozen when recorded, so ./priceRefresher.ts swaps fresher rates into the live process; the picker is registry.ts.
import { globalSingleton } from "../infra/globalSingleton";
import { DEFAULT_CURRENCY, type Currency } from "./currency";
import seed from "./model-pricing.json";

// Re-exported so this module stays the one place a rate's shape is described, while the constants
// themselves live in a leaf the client bundle can import without the price list. See ./currency.ts.
export { DEFAULT_CURRENCY, type Currency };

export interface CatalogEntry {
  provider: string;
  /** Which upstream list this rate came from — carried for review, not used by the cost math. */
  source: string;
  /** Absent means DEFAULT_CURRENCY, so an older vendored file keeps reading correctly. */
  currency?: Currency;
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

// On the Node global: server.ts (the refresher) and the Next-bundled routes (which price turns) load this module
// in separate scopes, so a plain `let` would leave every recorded cost on the boot-time seed.
type Holder = { entries: Record<string, CatalogEntry> };
const holder = globalSingleton<Holder>("modelPricingCatalog", () => ({
  entries: seed as Record<string, CatalogEntry>,
}));

/**
 * Replace the live rate table. Called by ./priceRefresher.ts after a successful fetch, and by tests.
 * Swapped wholesale rather than merged: a merge would keep a rate whose model upstream has dropped,
 * which is the stale-rate failure this is meant to end.
 */
export function setCatalog(entries: Record<string, CatalogEntry>): void {
  holder.entries = entries;
}

/** The rate table currently in force. Exported for the refresher's logging and for tests. */
export function getCatalog(): Record<string, CatalogEntry> {
  return holder.entries;
}

// Per-token rates for a model, in `currency`. Cache rates fall back to the plain input rate when the
// catalog doesn't break them out, so a provider without explicit cache pricing still costs something sane.
export interface Rate {
  input: number;
  cachedInput: number;
  cacheCreation: number;
  output: number;
  currency: Currency;
}

// The token counts recorded per turn (a subset of TurnRecord). Kept structural so usageStore and the
// dashboard can pass their records straight in without importing this module's shape.
export interface TokenCounts {
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  inputTokensCacheWrite: number;
  outputTokensTotal: number;
}

// Looks a model up by id, as given then by its bare tail. Own properties only: llmModel is free-form, and
// "constructor" must read as unknown, not as an inherited entry whose NaN cost poisons session totals.
const own = (key: string): CatalogEntry | undefined => {
  const entries = holder.entries;
  return Object.hasOwn(entries, key) ? entries[key] : undefined;
};

function lookup(modelId: string): CatalogEntry | undefined {
  return own(modelId) ?? own(modelId.split("/").pop() ?? modelId);
}

export function getRate(modelId: string | undefined): Rate | undefined {
  if (!modelId) return undefined;
  const e = lookup(modelId);
  if (!e) return undefined;
  return {
    input: e.input_cost_per_token,
    // Mistral bills cache hits at 10% of the normal input rate. Its LiteLLM rows do not currently
    // carry that field, so supply the documented rate here while still preferring an explicit one.
    cachedInput:
      e.cache_read_input_token_cost ??
      (e.provider === "mistral" ? e.input_cost_per_token * 0.1 : e.input_cost_per_token),
    cacheCreation: e.cache_creation_input_token_cost ?? e.input_cost_per_token,
    output: e.output_cost_per_token,
    currency: e.currency ?? DEFAULT_CURRENCY,
  };
}

/**
 * The currency a model's cost is denominated in, or undefined when the model isn't priced.
 *
 * Frozen alongside the cost itself (lib/usage/record.ts) rather than looked up at read time: the
 * catalog is swapped on a timer, so a later refresh must not restate an old turn's currency.
 */
export function getCurrency(modelId: string | undefined): Currency | undefined {
  return getRate(modelId)?.currency;
}

// One turn's cost in the model's own currency, or undefined when unpriced so callers show "unknown", not $0. Base
// input excludes cache reads and writes, which inputTokensTotal includes but are billed at their own rates.
export function computeCost(t: TokenCounts, modelId: string | undefined): number | undefined {
  const rate = getRate(modelId);
  if (!rate) return undefined;
  const uncachedInput = Math.max(0, t.inputTokensTotal - t.inputTokensCacheRead - t.inputTokensCacheWrite);
  return (
    uncachedInput * rate.input +
    t.inputTokensCacheRead * rate.cachedInput +
    t.inputTokensCacheWrite * rate.cacheCreation +
    t.outputTokensTotal * rate.output
  );
}

// LLM rate lookup. The data starts as a vendored copy of public price lists — LiteLLM for the bulk,
// models.dev for models LiteLLM hasn't published yet (./model-pricing.json), trimmed to the
// providers this app supports. Nothing hits the network at request time: the vendored file is the
// seed, and ./priceRefresher.ts swaps in fresher rates on a timer in the running server.
// Refresh the vendored seed at author time with `npm run update-pricing`.
//
// getRate / computeCost turn the per-turn token counts the runner already records into a USD cost
// (used by the usage dashboard). The set of models offered in the picker is a separate, code-owned
// list (lib/models/registry.ts); pricing is looked up here by model id when usage is recorded.
//
// A turn's cost is frozen at write time (lib/usage/record.ts), so a stale rate here is not a display
// bug that a later refresh repairs — it is permanently wrong in the database. That is why the
// refresher exists at all, and why the catalog has to be swappable in the live process.
import { globalSingleton } from "../infra/globalSingleton";
import seed from "./model-pricing.json";

interface CatalogEntry {
  provider: string;
  /** Which upstream list this rate came from — carried for review, not used by the cost math. */
  source: string;
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

// Held on the Node global, not in a module-level binding. The custom server (server.ts, where the
// refresher runs) and the webpack-bundled API routes (where appendUsage actually prices a turn) load
// this module into SEPARATE scopes — see globalSingleton. A plain `let` would let the refresher
// update its own copy while every recorded cost kept using the boot-time seed.
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

// Per-token USD rates for a model. Cache rates fall back to the plain input rate when the catalog
// doesn't break them out, so a provider without explicit cache pricing still costs something sane.
export interface Rate {
  input: number;
  cachedInput: number;
  cacheCreation: number;
  output: number;
}

// The token counts recorded per turn (a subset of TurnRecord). Kept structural so usageStore and the
// dashboard can pass their records straight in without importing this module's shape.
export interface TokenCounts {
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  inputTokensCacheWrite: number;
  outputTokensTotal: number;
}

// Looks a model up by id. Catalog keys come in bare (`deepseek-v4-pro`) and provider-prefixed
// (`deepseek/deepseek-v4-pro`) forms; we try the id as given, then the bare tail, so either works.
//
// OWN properties only. A workspace's llmModel is free-form (the PATCH route accepts a model that
// isn't in the catalog yet), so a plain index would let ids like "constructor" or "toString" hit
// Object.prototype and return a truthy non-entry — every rate then reads undefined and the cost
// comes back NaN, which propagates through the per-session SUM in lib/client/usageSessions.ts.
// "Unknown" is the contract for an unpriced model; NaN is not.
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
    cachedInput: e.cache_read_input_token_cost ?? e.input_cost_per_token,
    cacheCreation: e.cache_creation_input_token_cost ?? e.input_cost_per_token,
    output: e.output_cost_per_token,
  };
}

// USD cost for one turn's tokens. inputTokensTotal includes cache reads and cache writes; those
// buckets are billed separately below, so base input subtracts both to avoid double-charging.
// Returns undefined when the model isn't in the catalog so callers can render "unknown" rather
// than a misleading $0.
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

// LLM rate lookup. The data is a vendored copy of LiteLLM's public price list
// (lib/workspace/model-pricing.json), trimmed to the providers this app supports. It is DATA WE OWN
// — nothing hits the network at request time. Refresh it with `npm run update-pricing`.
//
// getRate / computeCost turn the per-turn token counts the runner already records into a USD cost
// (used by the usage dashboard). The set of models offered in the picker is a separate, code-owned
// list (lib/workspace/models.ts); pricing is looked up here by model id when usage is recorded.
import catalog from "./model-pricing.json";

interface CatalogEntry {
  litellm_provider: string;
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

const CATALOG = catalog as Record<string, CatalogEntry>;

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
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
}

// Looks a model up by id. Catalog keys come in bare (`deepseek-v4-pro`) and provider-prefixed
// (`deepseek/deepseek-v4-pro`) forms; we try the id as given, then the bare tail, so either works.
function lookup(modelId: string): CatalogEntry | undefined {
  return CATALOG[modelId] ?? CATALOG[modelId.split("/").pop() ?? modelId];
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

// USD cost for one turn's tokens. Providers report input_tokens as the grand total (cache reads AND
// cache-creation are folded in — e.g. LangChain's Anthropic adapter sets input_tokens = base +
// cache_read + cache_creation), and those buckets are billed separately below, so uncached input is
// (input − cached − cache-creation) to avoid double-charging them. For OpenAI/DeepSeek cacheCreation
// is 0, so this is a no-op there. Returns undefined when the model isn't in the catalog so callers
// can render "unknown" rather than a misleading $0.
export function computeCost(t: TokenCounts, modelId: string | undefined): number | undefined {
  const rate = getRate(modelId);
  if (!rate) return undefined;
  const uncachedInput = Math.max(0, t.inputTokens - t.cachedInputTokens - t.cacheCreationTokens);
  return (
    uncachedInput * rate.input +
    t.cachedInputTokens * rate.cachedInput +
    t.cacheCreationTokens * rate.cacheCreation +
    t.outputTokens * rate.output
  );
}

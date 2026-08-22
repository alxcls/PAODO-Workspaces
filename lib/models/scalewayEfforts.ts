/**
 * What each Scaleway model does with `reasoning_effort`, transcribed from the vendor's own product
 * catalog (`properties.generative_apis` on every Generative APIs row).
 *
 * CHECKED IN RATHER THAN FETCHED, unlike the prices next door. A rate only changes a number; this
 * changes what the picker offers and what validateMetadata accepts, so having it swing on a network
 * call would let a vendor outage silently narrow a workspace's stored choice. Instead
 * `npm run update-pricing` re-reads the same rows and FAILS on any drift from this table, which
 * gives derivation's correctness without making the running app depend on the fetch.
 *
 * The gateway is NOT what enforces this. It validates `reasoning_effort` against vLLM's full union
 * for every model, so an unsupported level is accepted and then quietly collapses to the model's
 * default — no error, just a dial with two labels for one behaviour. This table is the only place
 * that distinction is written down.
 */
import type { ReasoningEffort } from "./llmSelection";

export interface ScalewayModelEfforts {
  /** `supported_reasoning_values`, ordered quietest first — the levels the picker may offer. */
  supported: readonly ReasoningEffort[];
  /** `default_reasoning_value`: what the model reasons at when a request names no level. */
  fallback: ReasoningEffort;
}

/** Keyed by the serverless model id in lib/models/registry.ts. A model absent here has no narrowing. */
export const SCALEWAY_MODEL_EFFORTS: Readonly<Record<string, ScalewayModelEfforts>> = {
  "deepseek-v4-flash-0731": { supported: ["none", "low", "high", "max"], fallback: "high" },
  // Genuinely binary: "medium" is its only thinking level, so the picker shows a checkbox, not a dial.
  "qwen3.6-35b-a3b": { supported: ["none", "medium"], fallback: "medium" },
};

/** The same table as the plain model→levels map the vocabulary and the catalog API carry. */
export function scalewayModelEffortLists(): Record<string, readonly ReasoningEffort[]> {
  return Object.fromEntries(Object.entries(SCALEWAY_MODEL_EFFORTS).map(([model, { supported }]) => [model, supported]));
}

/**
 * Every level any offered Scaleway model accepts, quietest first.
 *
 * The provider-wide list is the UNION, not the intersection it used to be. The intersection was
 * `["none"]` once the vendor data was read properly — a dial with nothing to choose — and the union is
 * only safe because SCALEWAY_MODEL_EFFORTS narrows it per model everywhere it is offered or checked.
 */
export function scalewayProviderEfforts(): ReasoningEffort[] {
  const order: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const union = new Set(Object.values(SCALEWAY_MODEL_EFFORTS).flatMap((entry) => entry.supported));
  return order.filter((effort) => union.has(effort));
}

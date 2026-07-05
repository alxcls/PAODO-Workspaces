// Refreshes the vendored model-pricing catalog (lib/workspace/model-pricing.json) from LiteLLM's
// public price list. This is the ONLY thing that touches the network for pricing — it runs manually
// (`npm run update-pricing`), never at request time. New models land in the app the next time this
// is run. See lib/workspace/modelPricing.ts for how the file is consumed.
//
// The upstream file carries ~3000 models across every provider; we keep only the three providers this
// app supports and only the fields the cost math needs, so the vendored file stays small and
// reviewable in a diff. (The picker's model list is a separate code-owned catalog: lib/workspace/models.ts.)
import { writeFileSync } from "fs";
import path from "path";

const SOURCE =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PROVIDERS = new Set(["anthropic", "openai", "deepseek"]);
const OUT = path.join(__dirname, "..", "lib", "workspace", "model-pricing.json");

interface UpstreamEntry {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

interface VendoredEntry {
  litellm_provider: string;
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

async function main() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const upstream = (await res.json()) as Record<string, UpstreamEntry>;

  const out: Record<string, VendoredEntry> = {};
  for (const [id, e] of Object.entries(upstream)) {
    if (!e.litellm_provider || !PROVIDERS.has(e.litellm_provider)) continue;
    // Skip models with no usable rate (some catalog rows are context-window-only).
    if (typeof e.input_cost_per_token !== "number" || typeof e.output_cost_per_token !== "number") continue;
    out[id] = {
      litellm_provider: e.litellm_provider,
      input_cost_per_token: e.input_cost_per_token,
      output_cost_per_token: e.output_cost_per_token,
      ...(typeof e.cache_read_input_token_cost === "number" && { cache_read_input_token_cost: e.cache_read_input_token_cost }),
      ...(typeof e.cache_creation_input_token_cost === "number" && { cache_creation_input_token_cost: e.cache_creation_input_token_cost }),
    };
  }

  // Sort by id for a stable, diff-friendly file.
  const sorted = Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

  writeFileSync(OUT, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`wrote ${Object.keys(sorted).length} models to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

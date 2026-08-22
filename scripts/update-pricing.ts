// Refreshes the vendored model-pricing catalog (lib/models/model-pricing.json) from public price
// lists, at author time (`npm run update-pricing`).
//
// This file is now only the CLI wrapper — fetching and assembling the catalog lives in
// lib/models/refresh.ts, shared with lib/models/priceRefresher.ts so the script and the running
// server can never build the catalog differently. See that file for the source strategy.
//
// WHAT THIS FILE IS STILL FOR, now that production refreshes itself: the vendored file is the SEED
// a container boots on before its first fetch, and the offline fallback if upstream is unreachable.
// Re-running this keeps that seed from drifting years behind. It is no longer the mechanism by which
// prices reach production.
//
// The run FAILS if any offered model still has no rate, because lib/models/registry.test.ts asserts
// every offered model prices — better to find out here than in CI.
//
// (The picker's model list is a separate code-owned catalog: lib/models/registry.ts.)
import { writeFileSync } from "fs";
import path from "path";
import { buildCatalog } from "../lib/models/refresh";

// Must stay in step with the `import seed from "./model-pricing.json"` in lib/models/pricing.ts:
// writing anywhere else leaves the app on the old rates while this script reports success.
const OUT = path.join(__dirname, "..", "lib", "models", "model-pricing.json");

async function main() {
  const { catalog, filled, scaleway, unpriced, effortDrift, sourceFailures } = await buildCatalog();

  // BEFORE the write, unlike every check below it: an unreachable or incomplete source yields a
  // catalog missing models, and this file is the seed every fresh deployment boots on. Vendoring
  // that commits the hole.
  if (sourceFailures.length) {
    console.error(`\nSOURCE INCOMPLETE OR UNREACHABLE: ${sourceFailures.join(", ")}`);
    console.error(`${OUT} left untouched. Re-run once the source is back.`);
    process.exit(1);
  }

  writeFileSync(OUT, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`wrote ${Object.keys(catalog).length} models to ${path.relative(process.cwd(), OUT)}`);
  if (filled.length) console.log(`filled from models.dev (not yet in LiteLLM): ${filled.join(", ")}`);
  if (scaleway.length) console.log(`priced in EUR from Scaleway's own catalog: ${scaleway.join(", ")}`);

  // Prices are vendored above; the reasoning table is not, so drift in it has to be reported rather
  // than written. See lib/models/scalewayEfforts.ts for why that one stays hand-maintained.
  if (effortDrift.length) {
    console.error(`\nSCALEWAY REASONING LEVELS MOVED:\n  ${effortDrift.join("\n  ")}`);
    console.error("Update SCALEWAY_MODEL_EFFORTS in lib/models/scalewayEfforts.ts to match, then re-run.");
    process.exit(1);
  }
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

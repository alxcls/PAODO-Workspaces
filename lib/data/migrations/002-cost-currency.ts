import type { Migration } from "./index";

/**
 * Records which currency a turn's cost was billed in.
 *
 * Added when Scaleway joined the provider registry: it bills in euros, and its rates are taken from
 * its own catalog rather than converted, so `cost_usd` stopped being a dollar figure for every row.
 * The column is left NULL on existing rows and read as USD — which is what every pre-Scaleway turn
 * actually was. `cost_usd` keeps its name so no historical row has to be rewritten to add a column.
 */
export const costCurrency: Migration = {
  version: 2,
  name: "cost-currency",
  up(db) {
    db.exec(`ALTER TABLE usage_turns ADD COLUMN cost_currency TEXT`);
  },
};

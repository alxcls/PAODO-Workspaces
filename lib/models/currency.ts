/**
 * What currency a rate is quoted in. A leaf module ON PURPOSE: it imports nothing.
 *
 * These two names belong to ./pricing.ts conceptually, and it re-exports them — but that module also
 * imports the whole vendored price list, and lib/client/usageSessions.ts needs the currency to render
 * a dashboard cell. Reaching for it there would drag ~46KB of rates into the browser bundle for one
 * string constant, the same graph lib/usage/types.ts and components/home/ModelBlock.tsx already take
 * care to keep out of the client. Splitting the constant off is what makes that import free.
 *
 * Deliberately NOT converted anywhere: a turn's cost is frozen at write time (lib/usage/record.ts),
 * so folding in an exchange rate would freeze that day's rate too, and the number would drift from
 * what the vendor actually invoiced. Costs in different currencies are kept apart, never added up.
 */

/** Both bulk price lists quote USD; Scaleway bills in euros and its own catalog says so. */
export type Currency = "USD" | "EUR";

/** Where a rate carries no currency — every entry vendored before the field existed. */
export const DEFAULT_CURRENCY: Currency = "USD";

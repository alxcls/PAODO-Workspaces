// Formatting for the usage dashboard's cells; the per-run grouping itself is lib/usage/sessions.ts.
// The currency leaf, NOT lib/models/pricing: that module carries the whole vendored price list.
import type { Currency } from "@/lib/models/currency";
import type { LightSession } from "@/lib/usage/sessions";
import type { RunErrorRecord, SessionOrigin } from "@/lib/usage/types";

/** One-line rendering of a run error: the code, when there is one, then the message. */
export function formatRunError(error: RunErrorRecord): string {
  return error.code ? `[${error.code}] ${error.message}` : error.message;
}

export function formatTokens(n: number): string {
  if (n === 0) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

const CURRENCY_SYMBOL: Record<Currency, string> = { USD: "$", EUR: "€" };

// One amount with its currency symbol. Sub-cent totals get more precision.
function formatAmount(cost: number, currency: Currency): string {
  const symbol = CURRENCY_SYMBOL[currency];
  if (cost === 0) return symbol + "0";
  if (cost < 0.01) return symbol + cost.toFixed(4);
  return symbol + cost.toFixed(cost < 1 ? 3 : 2);
}

type SessionCost = Pick<LightSession, "cost" | "costByCurrency">;

/**
 * A session's total, spelled out per currency — the only correct rendering when a run mixed them.
 *
 * A session with no priced turn renders "—" rather than a misleading $0, and one that mixed
 * currencies renders its parts joined by "+", never as one number: euros and dollars are not
 * addable, and the per-currency subtotals are each individually true.
 */
export function formatSessionCost(session: SessionCost): string {
  const parts = Object.entries(session.costByCurrency) as Array<[Currency, number]>;
  if (parts.length === 0) return "—";
  return parts.map(([currency, amount]) => formatAmount(amount, currency)).join(" + ");
}

/** The hover title behind that cell: full precision, or why there is no number to show. */
export function formatSessionCostTitle(session: SessionCost): string {
  const parts = Object.entries(session.costByCurrency) as Array<[Currency, number]>;
  if (parts.length === 0) return "No pricing for this session's model(s)";
  return parts.map(([currency, amount]) => `${CURRENCY_SYMBOL[currency]}${amount.toFixed(6)}`).join(" + ");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function originLabel(origin: SessionOrigin): string {
  switch (origin) {
    case "chat":
      return "Workspace chat";
    case "api":
      return "API";
    case "mcp":
      return "Workspace MCP";
    case "scheduled":
      return "Scheduled";
    case "agent":
      return "Agent graph";
    // Records created before explicit source tracking used `manual`.
    case "manual":
      return "Workspace chat";
  }
}

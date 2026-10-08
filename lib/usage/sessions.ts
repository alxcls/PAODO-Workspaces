// One row per run (session), folded from the light per-turn usage records. Shared by the dashboard and
// the conversation sessions route, so both report the same totals; rendering stays in lib/client.
import { DEFAULT_CURRENCY, type Currency } from "../models/currency";
import type { LightTurnRecord, RunErrorRecord, SessionOrigin, SessionStatus } from "./types";

// One user message ("turn line") = one run = one sessionId. The dashboard shows both the session id and
// the conversation id, linked to its conversation tab.
export interface LightSession {
  sessionId: string;
  conversationId?: string;
  /** The conversation is still openable — false once it (or its workspace) was deleted. */
  conversationLive: boolean;
  workspaceId: string;
  workspaceName: string;
  origin: SessionOrigin;
  status: SessionStatus;
  timestamp: string;
  // Distinct model ids used across the run's turns, in first-seen order; usually one.
  models: string[];
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  outputTokensTotal: number;
  toolTotal: number;
  // undefined until a priced turn contributes; stays undefined if no turn's model is in the catalog.
  cost: number | undefined;
  /**
   * Per-currency subtotals, because a session is free to switch models mid-run and a euro-priced
   * Scaleway turn cannot be added to a dollar-priced one. `cost` above stays the total ONLY while a
   * session is single-currency, and is undefined the moment two appear — a sum across currencies is
   * a number that means nothing, and showing it would be worse than showing the parts.
   */
  costByCurrency: Partial<Record<Currency, number>>;
  // The last error recorded across the run's turns: what stopped it. A failed tool call the agent
  // recovered from is not a failed run; those stay visible as red dots inside the drawer.
  error?: RunErrorRecord;
}

export function groupBySessions(records: LightTurnRecord[]): LightSession[] {
  const map = new Map<string, LightSession>();
  // Timestamp of each session's kept error, so the latest wins whatever the arrival order. A tie keeps the
  // first seen: the terminal error row can share a millisecond with its cause, and newest-first lists it first.
  const errorAt = new Map<string, string>();
  for (const r of records) {
    let s = map.get(r.sessionId);
    if (!s) {
      s = {
        sessionId: r.sessionId,
        conversationId: r.conversationId,
        conversationLive: false,
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName,
        origin: r.origin ?? "manual",
        status: r.status,
        timestamp: r.timestamp,
        models: [],
        inputTokensTotal: 0,
        inputTokensCacheRead: 0,
        outputTokensTotal: 0,
        toolTotal: 0,
        cost: undefined,
        costByCurrency: {},
      };
      map.set(r.sessionId, s);
    }
    if (r.conversationLive) s.conversationLive = true;
    if (r.error && r.timestamp > (errorAt.get(r.sessionId) ?? "")) {
      s.error = r.error;
      errorAt.set(r.sessionId, r.timestamp);
    }
    if (r.model && !s.models.includes(r.model)) s.models.push(r.model);
    s.inputTokensTotal += r.inputTokensTotal;
    s.inputTokensCacheRead += r.inputTokensCacheRead;
    s.outputTokensTotal += r.outputTokensTotal;
    s.toolTotal += r.toolCalls.length;
    // Cost is frozen by the usage store; dashboard reads never re-price historical turns.
    const c = r.cost;
    if (c !== undefined) {
      const currency = r.costCurrency ?? DEFAULT_CURRENCY;
      s.costByCurrency[currency] = (s.costByCurrency[currency] ?? 0) + c;
      const totals = Object.values(s.costByCurrency);
      s.cost = totals.length === 1 ? totals[0] : undefined;
    }
    if (r.timestamp < s.timestamp) s.timestamp = r.timestamp;
  }
  // Newest STARTED first: a caller's final relay turn is its last record, so sorting by latest turn would
  // float it above its callee.
  return Array.from(map.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

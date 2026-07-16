// Pure, view-agnostic logic behind the usage dashboard: fold the light per-turn usage records into
// one row per run (session), and format the scalar cells. Kept out of the page component so it's unit
// testable and the component stays presentational.
import type { LightTurnRecord, SessionOrigin } from "../workspace/usageStore";
import { computeCost } from "../workspace/modelPricing";

// One user message ("turn line") = one run = one sessionId, aggregated from the light per-turn
// records. The row shows both IDs: the session id (the per-run identifier) and the conversation
// id (linked to its conversation tab).
export interface LightSession {
  sessionId: string;
  conversationId?: string;
  workspaceId: string;
  workspaceName: string;
  origin: SessionOrigin;
  timestamp: string;
  // Distinct model ids used across the run's turns, in first-seen order. Usually one; a run that
  // switches models mid-flight lists each once.
  models: string[];
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolTotal: number;
  // undefined until a priced turn contributes; stays undefined if no turn's model is in the catalog.
  cost: number | undefined;
}

export function groupBySessions(records: LightTurnRecord[]): LightSession[] {
  const map = new Map<string, LightSession>();
  for (const r of records) {
    let s = map.get(r.sessionId);
    if (!s) {
      s = {
        sessionId: r.sessionId,
        conversationId: r.conversationId,
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName,
        origin: r.origin ?? "manual",
        timestamp: r.timestamp,
        models: [],
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        toolTotal: 0,
        cost: undefined,
      };
      map.set(r.sessionId, s);
    }
    if (r.model && !s.models.includes(r.model)) s.models.push(r.model);
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
    s.cachedInputTokens += r.cachedInputTokens;
    s.toolTotal += r.toolCalls.length;
    // Cost is per-turn: each turn may run on a different model, so sum computeCost across turns.
    // A turn whose model isn't in the catalog contributes nothing but doesn't invalidate the total.
    const c = computeCost(r, r.model);
    if (c !== undefined) s.cost = (s.cost ?? 0) + c;
    if (r.timestamp < s.timestamp) s.timestamp = r.timestamp;
  }
  // Order by when each session STARTED (newest first) — see the agent-to-agent note: a caller's
  // final relay turn is its last record, so sorting by latest turn would float it above its callee.
  return Array.from(map.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function formatTokens(n: number): string {
  if (n === 0) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

// USD cost per session. `cost` is undefined when no turn's model was found in the pricing catalog, in
// which case we show "—" rather than a misleading $0. Sub-cent totals get more precision.
export function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return "$" + cost.toFixed(4);
  return "$" + cost.toFixed(cost < 1 ? 3 : 2);
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function originLabel(origin: SessionOrigin): string {
  switch (origin) {
    case "chat": return "Workspace chat";
    case "api": return "API";
    case "mcp": return "Workspace MCP";
    case "scheduled": return "Scheduled";
    case "agent": return "Agent network";
    // Records created before explicit source tracking used `manual`.
    case "manual": return "Workspace chat";
  }
}

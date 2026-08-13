// Pure, view-agnostic logic behind the usage dashboard: fold the light per-turn usage records into
// one row per run (session), and format the scalar cells. Kept out of the page component so it's unit
// testable and the component stays presentational.
import type { LightTurnRecord, RunErrorRecord, SessionOrigin } from "@/lib/usage/types";

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
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  outputTokensTotal: number;
  toolTotal: number;
  // undefined until a priced turn contributes; stays undefined if no turn's model is in the catalog.
  cost: number | undefined;
  // The run's terminal error, if any — the last one recorded across the run's turns, which is what
  // stopped it. undefined means the run finished without an error (a failed tool call the agent
  // recovered from is not a failed run; those stay visible as red dots inside the drawer).
  error?: RunErrorRecord;
}

export function groupBySessions(records: LightTurnRecord[]): LightSession[] {
  const map = new Map<string, LightSession>();
  // Timestamp of the turn each session's kept error came from, so the latest one wins regardless of
  // the order the records arrive in. A tie keeps the first one seen: recordRunError writes the
  // terminal error as its own row, which can land in the same millisecond as the turn error that
  // caused it, and the newest-first list puts the terminal one first.
  const errorAt = new Map<string, string>();
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
        inputTokensTotal: 0,
        inputTokensCacheRead: 0,
        outputTokensTotal: 0,
        toolTotal: 0,
        cost: undefined,
      };
      map.set(r.sessionId, s);
    }
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
    if (c !== undefined) s.cost = (s.cost ?? 0) + c;
    if (r.timestamp < s.timestamp) s.timestamp = r.timestamp;
  }
  // Order by when each session STARTED (newest first) — see the agent-to-agent note: a caller's
  // final relay turn is its last record, so sorting by latest turn would float it above its callee.
  return Array.from(map.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** One-line rendering of a run error: the code, when there is one, then the message. */
export function formatRunError(error: RunErrorRecord): string {
  return error.code ? `[${error.code}] ${error.message}` : error.message;
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
      return "Agent network";
    // Records created before explicit source tracking used `manual`.
    case "manual":
      return "Workspace chat";
  }
}

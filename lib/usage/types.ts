// The usage record shapes — what one persisted agent turn looks like in application terms. Kept
// deliberately dependency-free (no better-sqlite3, no db handle, no logger) because the dashboard
// page, the browser-side session grouping in lib/client/usageSessions.ts, and the agent runtime all
// need to name these types, and none of them should pull the storage layer into their import graph.
//
// The SQL column shapes these map onto live in ./rows.ts, the writers in ./record.ts, the readers in
// ./queries.ts.

import type { Currency } from "../models/currency";

// Outcome of a tool call, decided at the source (the runner) and persisted so the dashboard can
// render it without re-parsing output. "needs_input" is the A2A non-terminal retry state.
export type ToolStatus = "ok" | "error" | "needs_input";
/** How this agent run was initiated. `manual` is retained to render historical records. */
export type SessionOrigin = "chat" | "api" | "mcp" | "scheduled" | "agent" | "manual";
export type SessionStatus = "running" | "success" | "failed" | "cancelled" | "timeout" | "limit_reached" | "incomplete";

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  output: string;
  status: ToolStatus;
}

export interface RunErrorRecord {
  code?: string;
  message: string;
}

export interface SessionRecord {
  id: string;
  workspaceId: string;
  workspaceName: string;
  conversationId?: string;
  origin: SessionOrigin;
  userInput?: string;
  /** Missing only on sessions migrated from a schema that did not retain prompts. */
  systemPrompt?: string;
  startedAt: string;
  completedAt?: string;
  status: SessionStatus;
  error?: RunErrorRecord;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  timestamp: string;
  /** The concrete model id this turn ran on. */
  model?: string;
  /** Total model input, including cache reads and cache writes. */
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  inputTokensCacheWrite: number;
  outputTokensTotal: number;
  outputTokensReasoning: number;
  /** Cost frozen at write time; undefined means the model was not in the pricing catalog. */
  cost?: number;
  /** The currency `cost` is in, frozen with it. Undefined alongside an undefined cost. */
  costCurrency?: Currency;
  reasoningText?: string;
  outputText?: string;
  toolCalls: ToolCallRecord[];
}

export type NewTurnRecord = Omit<TurnRecord, "id" | "timestamp" | "cost" | "costCurrency"> & { id?: string };

export type TurnUsageFields = Omit<TurnRecord, "id" | "timestamp" | "sessionId" | "cost" | "costCurrency"> & {
  turnId: string;
};

export interface SessionDetailRecord {
  session: SessionRecord;
  turns: TurnRecord[];
}

/** Lightweight dashboard fields; full text and tool I/O stay in SQLite but are not selected. */
export interface LightTurnRecord {
  id: string;
  sessionId: string;
  conversationId?: string;
  /**
   * Whether that conversation still exists. Usage records outlive conversations (deleting a
   * workspace drops its replay state but keeps its execution records), so the dashboard keeps
   * showing the id either way but only links one it can actually open.
   */
  conversationLive?: boolean;
  workspaceId: string;
  workspaceName: string;
  origin?: SessionOrigin;
  timestamp: string;
  model?: string;
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  inputTokensCacheWrite: number;
  outputTokensTotal: number;
  outputTokensReasoning: number;
  cost?: number;
  costCurrency?: Currency;
  error?: RunErrorRecord;
  toolCalls: Array<{ name: string; status: ToolStatus }>;
}

/**
 * Session token totals projected onto one turn — see getConversationOutputTokens in ./queries.ts.
 * Narrower than TurnRecord on purpose: chat renders an aggregate badge, not per-turn accounting.
 */
export interface OutputTokenUsage {
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  outputTokensTotal: number;
}

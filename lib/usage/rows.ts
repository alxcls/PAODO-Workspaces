// The SQLite boundary for usage records: the column shapes the two usage tables return, the INSERT
// statements, and the row→record converters. Sits between ./types.ts (application shapes) and the
// two callers — ./record.ts writes through insertRecord, ./queries.ts maps its own SELECT results
// back through rowToTurn/errorFromRow.
//
// The read SQL deliberately stays in ./queries.ts: each SELECT is shaped by the response it serves
// (light list vs. full session drawer vs. session totals), so there is no shared statement to
// extract. What IS shared, and lives here, is the translation every reader needs identically —
// null↔undefined, JSON↔object, and validating a stored status string back into the union.
import type Database from "better-sqlite3";
import type { RunErrorRecord, SessionOrigin, ToolStatus, TurnRecord } from "./types";

export interface TurnRow {
  seq: number;
  id: string;
  session_id: string;
  conversation_id: string | null;
  workspace_id: string;
  workspace_name: string;
  origin: string | null;
  timestamp: string;
  user_input: string | null;
  model: string | null;
  input_tokens_total: number;
  input_tokens_cache_read: number;
  input_tokens_cache_write: number;
  output_tokens_total: number;
  output_tokens_reasoning: number;
  cost_usd: number | null;
  reasoning_text: string | null;
  output_text: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface JoinedTurnRow extends TurnRow {
  tool_position: number | null;
  tool_name: string | null;
  tool_args_json: string | null;
  tool_output: string | null;
  tool_status: string | null;
}

export interface LightJoinedRow
  extends Omit<TurnRow, "user_input" | "reasoning_text" | "output_text" | "error_code" | "error_message"> {
  error_code: string | null;
  error_message: string | null;
  /** 1/0 from the EXISTS check on `conversations` — not a stored column. */
  conversation_live: number;
  tool_position: number | null;
  tool_name: string | null;
  tool_status: string | null;
}

const INSERT_TURN_SQL = `
  INSERT OR IGNORE INTO usage_turns (
    id, session_id, conversation_id, workspace_id, workspace_name, origin, timestamp,
    user_input, model, input_tokens_total, input_tokens_cache_read, input_tokens_cache_write,
    output_tokens_total, output_tokens_reasoning, cost_usd, reasoning_text, output_text,
    error_code, error_message
  ) VALUES (
    @id, @session_id, @conversation_id, @workspace_id, @workspace_name, @origin, @timestamp,
    @user_input, @model, @input_tokens_total, @input_tokens_cache_read, @input_tokens_cache_write,
    @output_tokens_total, @output_tokens_reasoning, @cost_usd, @reasoning_text, @output_text,
    @error_code, @error_message
  )
`;

const INSERT_TOOL_SQL = `
  INSERT INTO usage_tool_calls (turn_id, position, name, args_json, output, status)
  VALUES (@turn_id, @position, @name, @args_json, @output, @status)
`;

export function isToolStatus(value: unknown): value is ToolStatus {
  return value === "ok" || value === "error" || value === "needs_input";
}

function turnParams(record: TurnRecord) {
  return {
    id: record.id,
    session_id: record.sessionId,
    conversation_id: record.conversationId ?? null,
    workspace_id: record.workspaceId,
    workspace_name: record.workspaceName,
    origin: record.origin ?? null,
    timestamp: record.timestamp,
    user_input: record.userInput ?? null,
    model: record.model ?? null,
    input_tokens_total: record.inputTokensTotal,
    input_tokens_cache_read: record.inputTokensCacheRead,
    input_tokens_cache_write: record.inputTokensCacheWrite,
    output_tokens_total: record.outputTokensTotal,
    output_tokens_reasoning: record.outputTokensReasoning,
    cost_usd: record.cost ?? null,
    reasoning_text: record.reasoningText ?? null,
    output_text: record.outputText ?? null,
    error_code: record.error?.code ?? null,
    error_message: record.error?.message ?? null,
  };
}

/**
 * Insert one turn and its ordered tool calls. Returns false when the turn id already existed (the
 * INSERT OR IGNORE above), in which case the tool rows are skipped rather than duplicated. Must be
 * called inside a transaction — appendUsage owns that, so a throw anywhere here (e.g. JSON.stringify
 * on circular tool args) rolls back the turn row too.
 */
export function insertRecord(conn: Database.Database, record: TurnRecord): boolean {
  const inserted = conn.prepare(INSERT_TURN_SQL).run(turnParams(record));
  if (inserted.changes === 0) return false;

  const insertTool = conn.prepare(INSERT_TOOL_SQL);
  record.toolCalls.forEach((tool, position) => {
    insertTool.run({
      turn_id: record.id,
      position,
      name: tool.name,
      args_json: JSON.stringify(tool.args),
      output: tool.output,
      status: isToolStatus(tool.status) ? tool.status : "ok",
    });
  });
  return true;
}

export function errorFromRow(row: {
  error_code: string | null;
  error_message: string | null;
}): RunErrorRecord | undefined {
  if (row.error_message === null) return undefined;
  return {
    code: row.error_code ?? undefined,
    message: row.error_message,
  };
}

export function parseToolArgs(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Map a turn row to a record with an empty toolCalls — the caller folds joined tool rows into it. */
export function rowToTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    conversationId: row.conversation_id ?? undefined,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    origin: row.origin ? (row.origin as SessionOrigin) : undefined,
    timestamp: row.timestamp,
    userInput: row.user_input ?? undefined,
    model: row.model ?? undefined,
    inputTokensTotal: row.input_tokens_total,
    inputTokensCacheRead: row.input_tokens_cache_read,
    inputTokensCacheWrite: row.input_tokens_cache_write,
    outputTokensTotal: row.output_tokens_total,
    outputTokensReasoning: row.output_tokens_reasoning,
    cost: row.cost_usd ?? undefined,
    reasoningText: row.reasoning_text ?? undefined,
    outputText: row.output_text ?? undefined,
    error: errorFromRow(row),
    toolCalls: [],
  };
}

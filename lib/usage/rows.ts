// The SQLite boundary for model turns. Run-wide data lives in sessions; a turn contains only one
// model call's output, accounting, and ordered tool-call JSON.
//
// The read SQL deliberately stays in ./queries.ts: each SELECT is shaped by the response it serves
// (light list vs. full session drawer vs. session totals), so there is no shared statement to
// extract. What IS shared, and lives here, is the translation every reader needs identically —
// null↔undefined, JSON↔object, and validating a stored status string back into the union.
import type Database from "better-sqlite3";
import { DEFAULT_CURRENCY, type Currency } from "../models/currency";
import type { RunErrorRecord, ToolStatus, TurnRecord } from "./types";

export interface TurnRow {
  seq: number;
  id: string;
  session_id: string;
  timestamp: string;
  model: string | null;
  input_tokens_total: number;
  input_tokens_cache_read: number;
  input_tokens_cache_write: number;
  output_tokens_total: number;
  output_tokens_reasoning: number;
  cost_amount: number | null;
  cost_currency: string | null;
  reasoning_text: string | null;
  output_text: string | null;
  tool_calls_json: string;
}

export interface LightTurnRow {
  id: string;
  session_id: string;
  conversation_id: string | null;
  workspace_id: string;
  workspace_name: string;
  origin: string;
  timestamp: string;
  model: string | null;
  input_tokens_total: number;
  input_tokens_cache_read: number;
  input_tokens_cache_write: number;
  output_tokens_total: number;
  output_tokens_reasoning: number;
  cost_amount: number | null;
  cost_currency: string | null;
  tool_calls_json: string;
  error_code: string | null;
  error_message: string | null;
  /** 1/0 from the EXISTS check on `conversations` — not a stored column. */
  conversation_live: number;
}

const INSERT_TURN_SQL = `
  INSERT OR IGNORE INTO turns (
    id, session_id, timestamp, model,
    input_tokens_total, input_tokens_cache_read, input_tokens_cache_write,
    output_tokens_total, output_tokens_reasoning, cost_amount, cost_currency,
    reasoning_text, output_text, tool_calls_json
  ) VALUES (
    @id, @session_id, @timestamp, @model,
    @input_tokens_total, @input_tokens_cache_read, @input_tokens_cache_write,
    @output_tokens_total, @output_tokens_reasoning, @cost_amount, @cost_currency,
    @reasoning_text, @output_text, @tool_calls_json
  )
`;

function isToolStatus(value: unknown): value is ToolStatus {
  return value === "ok" || value === "error" || value === "needs_input";
}

function turnParams(record: TurnRecord) {
  return {
    id: record.id,
    session_id: record.sessionId,
    timestamp: record.timestamp,
    model: record.model ?? null,
    input_tokens_total: record.inputTokensTotal,
    input_tokens_cache_read: record.inputTokensCacheRead,
    input_tokens_cache_write: record.inputTokensCacheWrite,
    output_tokens_total: record.outputTokensTotal,
    output_tokens_reasoning: record.outputTokensReasoning,
    cost_amount: record.cost ?? null,
    cost_currency: record.costCurrency ?? null,
    reasoning_text: record.reasoningText ?? null,
    output_text: record.outputText ?? null,
    tool_calls_json: JSON.stringify(
      record.toolCalls.map((tool) => ({
        name: tool.name,
        args: tool.args,
        output: tool.output,
        status: isToolStatus(tool.status) ? tool.status : "ok",
      })),
    ),
  };
}

/**
 * Insert one model turn. Returns false when the turn id already exists. The caller owns the
 * transaction, so serializing invalid tool arguments cannot leave a partial record.
 */
export function insertRecord(conn: Database.Database, record: TurnRecord): boolean {
  return conn.prepare(INSERT_TURN_SQL).run(turnParams(record)).changes > 0;
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

export function toolCallsFromJson(value: string | null): TurnRecord["toolCalls"] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((tool) => {
      if (!tool || typeof tool !== "object") return [];
      const row = tool as Record<string, unknown>;
      if (typeof row.name !== "string") return [];
      return [
        {
          name: row.name,
          args:
            row.args && typeof row.args === "object" && !Array.isArray(row.args)
              ? (row.args as Record<string, unknown>)
              : {},
          output: typeof row.output === "string" ? row.output : "",
          status: isToolStatus(row.status) ? row.status : "ok",
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * The currency a stored cost is in. NULL on every row written before the column existed, and those
 * turns really were dollars, so an absent value on a PRICED row reads as the default rather than as
 * "unknown". An unpriced row has no currency at all — there is no amount for one to qualify.
 */
export function currencyFromRow(
  value: string | null | undefined,
  cost: number | null | undefined,
): Currency | undefined {
  if (cost == null) return undefined;
  if (value === "EUR" || value === "USD") return value;
  return value == null ? DEFAULT_CURRENCY : undefined;
}

export function rowToTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    model: row.model ?? undefined,
    inputTokensTotal: row.input_tokens_total,
    inputTokensCacheRead: row.input_tokens_cache_read,
    inputTokensCacheWrite: row.input_tokens_cache_write,
    outputTokensTotal: row.output_tokens_total,
    outputTokensReasoning: row.output_tokens_reasoning,
    cost: row.cost_amount ?? undefined,
    costCurrency: currencyFromRow(row.cost_currency, row.cost_amount),
    reasoningText: row.reasoning_text ?? undefined,
    outputText: row.output_text ?? undefined,
    toolCalls: toolCallsFromJson(row.tool_calls_json),
  };
}

// Persists complete per-turn usage records in SQLite.
//
// SQLite is the single source of truth: token metrics and the potentially large user input,
// reasoning, model output, tool arguments, and tool output are committed in one transaction.
// Dashboard list queries select only lightweight indexed fields; full text is fetched only when a
// session drawer is opened. The database retains all records. MAX_DASHBOARD_TURNS bounds only a
// single list response — it is not a retention policy.
import type Database from "better-sqlite3";
import { createLogger } from "../infra/logger";
import { computeCost } from "./modelPricing";
import { dataDb as db, invalidateDataDb } from "./dataDb";

const log = createLogger("usage");

const MAX_DASHBOARD_TURNS = 5000;

// Outcome of a tool call, decided at the source (the runner) and persisted so the dashboard can
// render it without re-parsing output. "needs_input" is the A2A non-terminal retry state.
export type ToolStatus = "ok" | "error" | "needs_input";
/** How this agent run was initiated. `manual` is retained to render historical records. */
export type SessionOrigin = "chat" | "api" | "mcp" | "scheduled" | "agent" | "manual";

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

export interface TurnRecord {
  id: string;
  sessionId: string;
  /** The callee/UI conversation this run belongs to, when it has one. */
  conversationId?: string;
  workspaceId: string;
  workspaceName: string;
  origin?: SessionOrigin;
  timestamp: string;
  /** The user message that started this session — set only on the session's first turn. */
  userInput?: string;
  /** The concrete model id this turn ran on. */
  model?: string;
  /** Total model input, including cache reads and cache writes. */
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  inputTokensCacheWrite: number;
  outputTokensTotal: number;
  outputTokensReasoning: number;
  /** USD cost frozen at write time; undefined means the model was not in the pricing catalog. */
  cost?: number;
  reasoningText?: string;
  outputText?: string;
  error?: RunErrorRecord;
  toolCalls: ToolCallRecord[];
}

export type NewTurnRecord = Omit<TurnRecord, "id" | "timestamp" | "cost"> & { id?: string };

export type TurnUsageFields = Omit<
  TurnRecord,
  "id" | "timestamp" | "sessionId" | "conversationId" | "workspaceId" | "workspaceName" | "cost"
> & { turnId: string };

export interface UsageContext {
  sessionId: string;
  conversationId?: string;
  workspaceId: string;
  workspaceName: string;
  origin?: SessionOrigin;
}

/** Lightweight dashboard fields; full text and tool I/O stay in SQLite but are not selected. */
export interface LightTurnRecord {
  id: string;
  sessionId: string;
  conversationId?: string;
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
  error?: RunErrorRecord;
  toolCalls: Array<{ name: string; status: ToolStatus }>;
}

interface TurnRow {
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

interface JoinedTurnRow extends TurnRow {
  tool_position: number | null;
  tool_name: string | null;
  tool_args_json: string | null;
  tool_output: string | null;
  tool_status: string | null;
}

interface LightJoinedRow
  extends Omit<TurnRow, "user_input" | "reasoning_text" | "output_text" | "error_code" | "error_message"> {
  error_code: string | null;
  error_message: string | null;
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

function isToolStatus(value: unknown): value is ToolStatus {
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

function insertRecord(conn: Database.Database, record: TurnRecord): boolean {
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

function errorFromRow(row: { error_code: string | null; error_message: string | null }): RunErrorRecord | undefined {
  if (row.error_message === null) return undefined;
  return {
    code: row.error_code ?? undefined,
    message: row.error_message,
  };
}

function parseToolArgs(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToTurn(row: TurnRow): TurnRecord {
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

export function appendUsage(partial: NewTurnRecord): void {
  const record: TurnRecord = {
    ...partial,
    id: partial.id ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
  record.cost = computeCost(record, record.model);

  try {
    const conn = db();
    conn.transaction(() => insertRecord(conn, record))();
  } catch (err) {
    invalidateDataDb();
    log.error(
      { event: "usage_record_insert_failed", outcome: "usage_record_not_persisted", err, id: record.id },
      "failed to persist usage record",
    );
  }
}

export function recordTurnUsage(
  ctx: UsageContext,
  usage: TurnUsageFields & { type?: string },
  append: (record: NewTurnRecord) => void = appendUsage,
): void {
  const { turnId, ...fields } = usage;
  delete fields.type;
  append({ ...ctx, ...fields, id: turnId });
}

/** Persist a terminal run error without pretending that an incomplete model turn consumed tokens. */
export function recordRunError(
  ctx: UsageContext,
  error: RunErrorRecord,
  userInput?: string,
  append: (record: NewTurnRecord) => void = appendUsage,
): void {
  append({
    ...ctx,
    userInput,
    inputTokensTotal: 0,
    inputTokensCacheRead: 0,
    inputTokensCacheWrite: 0,
    outputTokensTotal: 0,
    outputTokensReasoning: 0,
    toolCalls: [],
    error,
  });
}

export interface OutputTokenUsage {
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  outputTokensTotal: number;
}

/**
 * Session token totals keyed by the final visible-output turn. Execution detail remains per turn;
 * this projection lets chat show one aggregate badge on the answer that completed the run.
 */
export function getConversationOutputTokens(
  workspaceId: string,
  conversationId: string,
): Map<string, OutputTokenUsage> {
  const rows = db()
    .prepare(
      `
        WITH conversation_turns AS (
          SELECT
            seq,
            id,
            session_id,
            input_tokens_total,
            input_tokens_cache_read,
            output_tokens_total,
            output_text
          FROM usage_turns
          WHERE workspace_id = ? AND conversation_id = ?
        ),
        session_totals AS (
          SELECT
            session_id,
            SUM(input_tokens_total) AS input_tokens_total,
            SUM(input_tokens_cache_read) AS input_tokens_cache_read,
            SUM(output_tokens_total) AS output_tokens_total
          FROM conversation_turns
          GROUP BY session_id
        ),
        final_outputs AS (
          SELECT turn.session_id, MAX(turn.seq) AS final_seq
          FROM conversation_turns AS turn
          WHERE TRIM(COALESCE(turn.output_text, '')) <> ''
            AND NOT EXISTS (
              SELECT 1
              FROM usage_tool_calls AS tool
              WHERE tool.turn_id = turn.id
            )
          GROUP BY turn.session_id
        )
        SELECT
          turn.id,
          totals.input_tokens_total,
          totals.input_tokens_cache_read,
          totals.output_tokens_total
        FROM final_outputs
        JOIN conversation_turns AS turn ON turn.seq = final_outputs.final_seq
        JOIN session_totals AS totals ON totals.session_id = final_outputs.session_id
        ORDER BY turn.seq ASC
      `,
    )
    .all(workspaceId, conversationId) as Array<{
    id: string;
    input_tokens_total: number;
    input_tokens_cache_read: number;
    output_tokens_total: number;
  }>;

  return new Map(
    rows.map((row) => [
      row.id,
      {
        inputTokensTotal: row.input_tokens_total,
        inputTokensCacheRead: row.input_tokens_cache_read,
        outputTokensTotal: row.output_tokens_total,
      },
    ]),
  );
}

// Dashboard list payload — newest first, bounded for response size only. No heavy content columns
// are selected, so large prompts and tool output do not affect normal dashboard reads.
export function listUsageLight(workspaceId?: string): LightTurnRecord[] {
  const where = workspaceId ? "WHERE workspace_id = ?" : "";
  const params = workspaceId ? [workspaceId, MAX_DASHBOARD_TURNS] : [MAX_DASHBOARD_TURNS];
  const rows = db()
    .prepare(
      `
        SELECT
          recent.*,
          tools.position AS tool_position,
          tools.name AS tool_name,
          tools.status AS tool_status
        FROM (
          SELECT
            seq, id, session_id, conversation_id, workspace_id, workspace_name, origin, timestamp,
            model, input_tokens_total, input_tokens_cache_read, input_tokens_cache_write,
            output_tokens_total, output_tokens_reasoning, cost_usd, error_code, error_message
          FROM usage_turns
          ${where}
          ORDER BY seq DESC
          LIMIT ?
        ) AS recent
        LEFT JOIN usage_tool_calls AS tools ON tools.turn_id = recent.id
        ORDER BY recent.seq DESC, tools.position ASC
      `,
    )
    .all(...params) as LightJoinedRow[];

  const result: LightTurnRecord[] = [];
  const byId = new Map<string, LightTurnRecord>();
  for (const row of rows) {
    let record = byId.get(row.id);
    if (!record) {
      record = {
        id: row.id,
        sessionId: row.session_id,
        conversationId: row.conversation_id ?? undefined,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        origin: row.origin ? (row.origin as SessionOrigin) : undefined,
        timestamp: row.timestamp,
        model: row.model ?? undefined,
        inputTokensTotal: row.input_tokens_total,
        inputTokensCacheRead: row.input_tokens_cache_read,
        inputTokensCacheWrite: row.input_tokens_cache_write,
        outputTokensTotal: row.output_tokens_total,
        outputTokensReasoning: row.output_tokens_reasoning,
        cost: row.cost_usd ?? undefined,
        error: errorFromRow(row),
        toolCalls: [],
      };
      byId.set(row.id, record);
      result.push(record);
    }
    if (row.tool_name) {
      record.toolCalls.push({
        name: row.tool_name,
        status: isToolStatus(row.tool_status) ? row.tool_status : "ok",
      });
    }
  }
  return result;
}

// Full per-session detail, returned oldest first so tool executions render in run order.
export function getSessionDetail(sessionId: string): TurnRecord[] {
  const rows = db()
    .prepare(
      `
        SELECT
          turns.*,
          tools.position AS tool_position,
          tools.name AS tool_name,
          tools.args_json AS tool_args_json,
          tools.output AS tool_output,
          tools.status AS tool_status
        FROM usage_turns AS turns
        LEFT JOIN usage_tool_calls AS tools ON tools.turn_id = turns.id
        WHERE turns.session_id = ?
        ORDER BY turns.seq ASC, tools.position ASC
      `,
    )
    .all(sessionId) as JoinedTurnRow[];

  const result: TurnRecord[] = [];
  const byId = new Map<string, TurnRecord>();
  for (const row of rows) {
    let record = byId.get(row.id);
    if (!record) {
      record = rowToTurn(row);
      byId.set(row.id, record);
      result.push(record);
    }
    if (row.tool_name) {
      record.toolCalls.push({
        name: row.tool_name,
        args: parseToolArgs(row.tool_args_json),
        output: row.tool_output ?? "",
        status: isToolStatus(row.tool_status) ? row.tool_status : "ok",
      });
    }
  }
  return result;
}

// The usage read path. SQLite keeps every record; MAX_DASHBOARD_TURNS bounds one list response only.
// One SELECT per reader, so the dashboard list never touches the large text columns the drawer needs.
import { appDataDb as db } from "../data/database";
import { currencyFromRow, errorFromRow, rowToTurn, toolCallsFromJson } from "./rows";
import type { LightTurnRow, TurnRow } from "./rows";
import type {
  LightTurnRecord,
  OutputTokenUsage,
  SessionDetailRecord,
  SessionOrigin,
  SessionStatus,
  SessionTextRecord,
} from "./types";

const MAX_DASHBOARD_TURNS = 5000;

// A session's final answer: its last turn that wrote text and called no tool. Needs the turn aliased `turn`.
const FINAL_ANSWER_TURN = "TRIM(COALESCE(turn.output_text, '')) <> '' AND json_array_length(turn.tool_calls_json) = 0";

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
            turns.seq,
            turns.id,
            turns.session_id,
            turns.input_tokens_total,
            turns.input_tokens_cache_read,
            turns.output_tokens_total,
            turns.output_text,
            turns.tool_calls_json
          FROM turns
          JOIN sessions ON sessions.id = turns.session_id
          WHERE sessions.workspace_id = ? AND sessions.conversation_id = ?
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
          WHERE ${FINAL_ANSWER_TURN}
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
export function listUsageLight(workspaceId?: string, conversationId?: string, sessionId?: string): LightTurnRecord[] {
  const filters = [
    ...(workspaceId ? [{ clause: "sessions.workspace_id = ?", value: workspaceId }] : []),
    ...(conversationId ? [{ clause: "sessions.conversation_id = ?", value: conversationId }] : []),
    ...(sessionId ? [{ clause: "turns.session_id = ?", value: sessionId }] : []),
  ];
  const where = filters.length ? `WHERE ${filters.map((f) => f.clause).join(" AND ")}` : "";
  const params = [...filters.map((f) => f.value), MAX_DASHBOARD_TURNS];
  const rows = db()
    .prepare(
      `
        SELECT
            turns.seq, turns.id, turns.session_id,
            sessions.conversation_id, sessions.workspace_id, sessions.workspace_name, sessions.origin,
            sessions.status, turns.timestamp, turns.model,
            turns.input_tokens_total, turns.input_tokens_cache_read, turns.input_tokens_cache_write,
            turns.output_tokens_total, turns.output_tokens_reasoning,
            turns.cost_amount, turns.cost_currency, turns.tool_calls_json,
            sessions.error_code, sessions.error_message,
            -- Usage records outlive their conversations; the id stays for the audit trail, and this
            -- decides only whether the dashboard may offer it as a link.
            EXISTS (
              SELECT 1 FROM conversations
              WHERE conversations.workspace_id = sessions.workspace_id
                AND conversations.id = sessions.conversation_id
            ) AS conversation_live
        FROM turns
        JOIN sessions ON sessions.id = turns.session_id
        ${where}
        ORDER BY turns.seq DESC
        LIMIT ?
      `,
    )
    .all(...params) as LightTurnRow[];

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    conversationId: row.conversation_id ?? undefined,
    conversationLive: row.conversation_live === 1,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    origin: row.origin ? (row.origin as SessionOrigin) : undefined,
    status: row.status as SessionStatus,
    timestamp: row.timestamp,
    model: row.model ?? undefined,
    inputTokensTotal: row.input_tokens_total,
    inputTokensCacheRead: row.input_tokens_cache_read,
    inputTokensCacheWrite: row.input_tokens_cache_write,
    outputTokensTotal: row.output_tokens_total,
    outputTokensReasoning: row.output_tokens_reasoning,
    cost: row.cost_amount ?? undefined,
    costCurrency: currencyFromRow(row.cost_currency, row.cost_amount),
    error: errorFromRow(row),
    toolCalls: toolCallsFromJson(row.tool_calls_json).map(({ name, status }) => ({ name, status })),
  }));
}

/** Each session's user message and final answer, for one conversation or one session of it. */
export function listSessionTexts(workspaceId: string, conversationId: string, sessionId?: string): SessionTextRecord[] {
  const rows = db()
    .prepare(
      `
        SELECT
          sessions.id AS session_id,
          sessions.user_input,
          (
            SELECT turn.output_text FROM turns AS turn
            WHERE turn.session_id = sessions.id AND ${FINAL_ANSWER_TURN}
            ORDER BY turn.seq DESC
            LIMIT 1
          ) AS agent_response
        FROM sessions
        WHERE sessions.workspace_id = ? AND sessions.conversation_id = ?
          ${sessionId ? "AND sessions.id = ?" : ""}
      `,
    )
    .all(workspaceId, conversationId, ...(sessionId ? [sessionId] : [])) as Array<{
    session_id: string;
    user_input: string | null;
    agent_response: string | null;
  }>;

  return rows.map((row) => ({
    sessionId: row.session_id,
    userInput: row.user_input ?? undefined,
    agentResponse: row.agent_response ?? undefined,
  }));
}

interface SessionRow {
  id: string;
  workspace_id: string;
  workspace_name: string;
  conversation_id: string | null;
  origin: string;
  user_input: string | null;
  system_prompt: string | null;
  started_at: string;
  completed_at: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
}

// Session-owned data and its model turns stay in separate response buckets.
export function getSessionDetail(sessionId: string): SessionDetailRecord | undefined {
  const conn = db();
  const session = conn
    .prepare(
      `
        SELECT id, workspace_id, workspace_name, conversation_id, origin,
               user_input, system_prompt, started_at, completed_at, status,
               error_code, error_message
        FROM sessions
        WHERE id = ?
      `,
    )
    .get(sessionId) as SessionRow | undefined;
  if (!session) return undefined;

  const rows = conn
    .prepare(
      `
        SELECT
          turns.seq, turns.id, turns.session_id,
          turns.timestamp,
          turns.model,
          turns.input_tokens_total, turns.input_tokens_cache_read, turns.input_tokens_cache_write,
          turns.output_tokens_total, turns.output_tokens_reasoning,
          turns.cost_amount, turns.cost_currency,
          turns.reasoning_text, turns.output_text, turns.tool_calls_json
        FROM turns
        WHERE turns.session_id = ?
        ORDER BY turns.seq ASC
      `,
    )
    .all(sessionId) as TurnRow[];

  return {
    session: {
      id: session.id,
      workspaceId: session.workspace_id,
      workspaceName: session.workspace_name,
      conversationId: session.conversation_id ?? undefined,
      origin: session.origin as SessionOrigin,
      userInput: session.user_input ?? undefined,
      systemPrompt: session.system_prompt ?? undefined,
      startedAt: session.started_at,
      completedAt: session.completed_at ?? undefined,
      status: session.status as SessionStatus,
      error: errorFromRow(session),
    },
    turns: rows.map(rowToTurn),
  };
}

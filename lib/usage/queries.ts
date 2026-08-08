// The usage read path. SQLite is the single source of truth and retains every record —
// MAX_DASHBOARD_TURNS bounds one list response, it is not a retention policy.
//
// The three readers here have separate SELECTs on purpose rather than one query with a projection
// flag: the dashboard list must not touch the large text columns (user input, reasoning, model
// output, tool output), the session drawer must, and the conversation totals aggregate instead of
// listing. Each maps its rows back through the converters in ./rows.ts so column names live in one
// place per direction.
import { appDataDb as db } from "../data/database";
import { errorFromRow, isToolStatus, parseToolArgs, rowToTurn } from "./rows";
import type { JoinedTurnRow, LightJoinedRow } from "./rows";
import type { LightTurnRecord, OutputTokenUsage, SessionOrigin, TurnRecord } from "./types";

const MAX_DASHBOARD_TURNS = 5000;

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

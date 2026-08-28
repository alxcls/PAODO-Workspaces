// The usage write path. A session is created once by the run broker; model turns then reference it.
// Tool calls are serialized into the turn's JSON column before the single INSERT executes.
//
// Failures are logged and swallowed on purpose: usage accounting is a side record of an agent run
// and must never fail the run that produced it. invalidateAppDataDb drops the cached connection so
// the next write reopens rather than reusing a handle to a database that just rejected us.
import { createLogger } from "../infra/logger";
import { appDataDb as db, invalidateAppDataDb } from "../data/database";
import { computeCost, getCurrency } from "../models/pricing";
import { insertRecord } from "./rows";
import type { NewTurnRecord, RunErrorRecord, SessionOrigin, SessionStatus, TurnRecord, TurnUsageFields } from "./types";

const log = createLogger("usage");

export interface StartSessionInput {
  id: string;
  workspaceId: string;
  workspaceName: string;
  conversationId?: string;
  origin: SessionOrigin;
  userInput?: string;
  systemPrompt: string;
}

export function startUsageSession(input: StartSessionInput): void {
  try {
    db()
      .prepare(
        `
          INSERT INTO sessions (
            id, workspace_id, workspace_name, conversation_id,
            origin, user_input, system_prompt, started_at, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
        `,
      )
      .run(
        input.id,
        input.workspaceId,
        input.workspaceName,
        input.conversationId ?? null,
        input.origin,
        input.userInput ?? null,
        input.systemPrompt,
        new Date().toISOString(),
      );
  } catch (err) {
    invalidateAppDataDb();
    log.error(
      { event: "usage_session_insert_failed", outcome: "usage_session_not_persisted", err, id: input.id },
      "failed to persist usage session",
    );
  }
}

export function finishUsageSession(sessionId: string, status: SessionStatus, error?: RunErrorRecord): void {
  try {
    db()
      .prepare(
        `
          UPDATE sessions
          SET completed_at = ?, status = ?,
              error_code = COALESCE(?, error_code),
              error_message = COALESCE(?, error_message)
          WHERE id = ?
        `,
      )
      .run(new Date().toISOString(), status, error?.code ?? null, error?.message ?? null, sessionId);
  } catch (err) {
    invalidateAppDataDb();
    log.error(
      { event: "usage_session_update_failed", outcome: "usage_session_not_completed", err, id: sessionId },
      "failed to complete usage session",
    );
  }
}

export function appendUsage(partial: NewTurnRecord): void {
  const record: TurnRecord = {
    ...partial,
    id: partial.id ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
  // Both frozen together: a rate refresh must never restate what an old turn was billed, or in what.
  record.cost = computeCost(record, record.model);
  record.costCurrency = record.cost === undefined ? undefined : getCurrency(record.model);

  try {
    insertRecord(db(), record);
  } catch (err) {
    invalidateAppDataDb();
    log.error(
      { event: "usage_record_insert_failed", outcome: "usage_record_not_persisted", err, id: record.id },
      "failed to persist usage record",
    );
  }
}

export function recordTurnUsage(
  sessionId: string,
  usage: TurnUsageFields & { type?: string },
  append: (record: NewTurnRecord) => void = appendUsage,
): void {
  const { turnId, ...fields } = usage;
  delete fields.type;
  append({ sessionId, ...fields, id: turnId });
}

/** Persist a terminal run error without pretending that an incomplete model turn consumed tokens. */
export function recordRunError(sessionId: string, error: RunErrorRecord): void {
  finishUsageSession(
    sessionId,
    error.code === "TIMEOUT" ? "timeout" : error.code === "CANCELLED" ? "cancelled" : "failed",
    error,
  );
}

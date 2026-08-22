// The usage write path. Token metrics and the potentially large user input, reasoning, model output,
// tool arguments and tool output are committed in ONE transaction, so a turn and its tool calls are
// never half-persisted — see the circular-tool-args case in ./persistence.test.ts, where the
// JSON.stringify throw must leave both tables empty.
//
// Failures are logged and swallowed on purpose: usage accounting is a side record of an agent run
// and must never fail the run that produced it. invalidateAppDataDb drops the cached connection so
// the next write reopens rather than reusing a handle to a database that just rejected us.
import { createLogger } from "../infra/logger";
import { appDataDb as db, invalidateAppDataDb } from "../data/database";
import { computeCost, getCurrency } from "../models/pricing";
import { insertRecord } from "./rows";
import type { NewTurnRecord, RunErrorRecord, TurnRecord, TurnUsageFields, UsageContext } from "./types";

const log = createLogger("usage");

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
    const conn = db();
    conn.transaction(() => insertRecord(conn, record))();
  } catch (err) {
    invalidateAppDataDb();
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

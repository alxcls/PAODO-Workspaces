// REST endpoint for a workspace's single agent schedule.
// GET returns the schedule (or null); PUT creates/replaces it.
// The scheduler (started in server.ts) reads the same store and fires runs on the recurrence.
//
// Translation only: the rules, the messages and the "a replace keeps the id and the run history"
// behaviour are lib/operations/schedules/schedule.ts, so the CLI and any later adapter get the same
// answers without restating them. What is left here is HTTP — the not-found body, the unknown-field
// rejection, and turning an AppError into a status.
export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { notFound, requireWorkspace, workspaceIdParam } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { getWorkspaceSchedule, setWorkspaceSchedule, type ScheduleInput } from "@/lib/operations/schedules/schedule";

const log = createLogger("api").child({ route: "schedule" });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Guarded here rather than in the operation: on this path "no such workspace" and "no schedule yet"
  // are both answers, and only the route can tell them apart in its response.
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  return NextResponse.json(getWorkspaceSchedule(id));
}

/** The wire names PUT accepts, in one place so the rejection and its message cannot drift apart. */
const SCHEDULE_FIELDS = ["prompt", "intervalValue", "intervalUnit", "startAt", "endAt", "timezone", "enabled"] as const;

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const param = workspaceIdParam((await params).id, req);
  if (param instanceof NextResponse) return param;
  const id = param;

  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;

  // Reject anything not on the list rather than ignoring it. PUT is a replace, so a misspelled field
  // is a field the caller believes it set and we silently dropped — and the 200 that follows carries
  // the old value back, which reads as confirmation. The message names the accepted fields because a
  // programmatic caller has no form to discover them from.
  const unknown = Object.keys(parsed).filter((key) => !(SCHEDULE_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    return errorResponse(
      "INVALID_REQUEST",
      `unknown field(s): ${unknown.join(", ")} — accepted: ${SCHEDULE_FIELDS.join(", ")}`,
      {
        request: req,
        details: { fields: unknown, acceptedFields: [...SCHEDULE_FIELDS] },
      },
    );
  }

  try {
    // Forwarded as sent. Every value's type is checked by the validator that owns its rules, so one
    // layer states each rule once and every trigger gets the same rejection.
    const entry = setWorkspaceSchedule(id, parsed as ScheduleInput);
    if (!entry) return notFound(req);
    return NextResponse.json(entry);
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "schedule_save_failed",
        outcome: "schedule_not_saved",
        code: "INTERNAL_ERROR",
        err,
        workspaceId: id,
      },
      "failed to save schedule",
    );
    return errorResponse("INTERNAL_ERROR", "failed to save schedule", { request: req });
  }
}

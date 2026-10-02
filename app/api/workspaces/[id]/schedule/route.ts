// REST endpoint for a workspace's single agent schedule: GET returns it (or null), PUT replaces, PATCH merges.
// HTTP translation only — every rule, message and response shape is lib/operations/schedules/schedule.ts.
export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { notFound, requireWorkspace, workspaceIdParam } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import {
  getWorkspaceSchedule,
  setWorkspaceSchedule,
  patchWorkspaceSchedule,
  presentSchedule,
  type ScheduleInput,
} from "@/lib/operations/schedules/schedule";

const log = createLogger("api").child({ route: "schedule" });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Guarded here rather than in the operation: on this path "no such workspace" and "no schedule yet"
  // are both answers, and only the route can tell them apart in its response.
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  const entry = getWorkspaceSchedule(id);
  return NextResponse.json(entry && presentSchedule(entry));
}

type Context = { params: Promise<{ id: string }> };

export function PUT(req: NextRequest, context: Context) {
  return save(req, context, setWorkspaceSchedule);
}

export function PATCH(req: NextRequest, context: Context) {
  return save(req, context, patchWorkspaceSchedule);
}

async function save(req: NextRequest, { params }: Context, operation: typeof setWorkspaceSchedule) {
  const param = workspaceIdParam((await params).id, req);
  if (param instanceof NextResponse) return param;
  const id = param;

  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;

  try {
    // Forwarded as sent, unknown keys too: the validator reports them with every other bad field, so
    // one rejection lists all a caller has to fix.
    const entry = operation(id, parsed as ScheduleInput);
    if (!entry) return notFound(req, `workspace ${id}`);
    return NextResponse.json(presentSchedule(entry));
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

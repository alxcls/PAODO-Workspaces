// REST endpoint for a workspace's single agent schedule.
// GET returns the schedule (or null); PUT creates/replaces it.
// The scheduler (started in server.ts) reads the same store and fires runs on the recurrence.
export const runtime = "nodejs";

import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import {
  getSchedule,
  setSchedule,
  type IntervalUnit,
  type ScheduleEntry,
} from "@/lib/infra/schedules/scheduleStore";
import { computeNextRun, isValidTimezone } from "@/lib/infra/schedules/nextRun";

const UNITS: IntervalUnit[] = ["minute", "hour", "day", "week"];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return NextResponse.json(getSchedule(id));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const body = (await req.json().catch(() => null)) as {
    prompt?: string;
    intervalValue?: number;
    intervalUnit?: string;
    startAt?: string;
    endAt?: string | null;
    timezone?: string;
    enabled?: boolean;
  } | null;
  if (!body) return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });

  const prompt = body.prompt?.trim();
  if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });

  const intervalValue = body.intervalValue;
  if (!Number.isInteger(intervalValue) || (intervalValue as number) < 1) {
    return NextResponse.json({ error: "intervalValue must be an integer >= 1" }, { status: 400 });
  }

  if (!UNITS.includes(body.intervalUnit as IntervalUnit)) {
    return NextResponse.json({ error: `intervalUnit must be one of ${UNITS.join(", ")}` }, { status: 400 });
  }

  if (!body.timezone || !isValidTimezone(body.timezone)) {
    return NextResponse.json({ error: "timezone must be a valid IANA timezone" }, { status: 400 });
  }

  if (!body.startAt || Number.isNaN(Date.parse(body.startAt))) {
    return NextResponse.json({ error: "startAt must be a valid date-time" }, { status: 400 });
  }

  const endAt = body.endAt?.trim() || undefined;
  if (endAt) {
    if (Number.isNaN(Date.parse(endAt))) {
      return NextResponse.json({ error: "endAt must be a valid date" }, { status: 400 });
    }
    if (Date.parse(endAt) <= Date.parse(body.startAt)) {
      return NextResponse.json({ error: "endAt must be after startAt" }, { status: 400 });
    }
  }

  const existing = getSchedule(id);
  const entry: ScheduleEntry = {
    id: existing?.id ?? randomUUID(),
    workspaceId: id,
    prompt,
    intervalValue: intervalValue as number,
    intervalUnit: body.intervalUnit as IntervalUnit,
    startAt: body.startAt,
    endAt,
    timezone: body.timezone,
    enabled: body.enabled ?? true,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    nextRunAt: null,
    lastRunAt: existing?.lastRunAt,
    lastRunStatus: existing?.lastRunStatus,
    lastRunSnippet: existing?.lastRunSnippet,
  };
  const next = entry.enabled ? computeNextRun(entry, new Date()) : null;
  entry.nextRunAt = next ? next.toISOString() : null;

  setSchedule(entry);
  return NextResponse.json(entry);
}

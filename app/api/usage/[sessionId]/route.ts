// Full per-session usage detail (user input, reasoning text, tool args + output) for the
// dashboard drawer. Fetched lazily when a turn line is opened, so the main list stays light.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { getSessionDetail } from "@/lib/usage/queries";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return NextResponse.json(getSessionDetail(sessionId));
}

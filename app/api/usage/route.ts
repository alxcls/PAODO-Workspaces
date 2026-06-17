// Returns token usage records for a workspace, powering the usage dashboard.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { listUsageLight } from "@/lib/workspace/usageStore";

// Light list: token counts + tool names only. Heavy content (user input, reasoning,
// tool args/output) is loaded lazily per session via /api/usage/[sessionId].
export function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") ?? undefined;
  return NextResponse.json(listUsageLight(workspaceId));
}

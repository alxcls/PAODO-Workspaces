export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { listUsage } from "@/lib/workspace/usageStore";

export function GET(req: NextRequest) {
  const workspaceId = req.nextUrl.searchParams.get("workspaceId") ?? undefined;
  return NextResponse.json(listUsage(workspaceId));
}

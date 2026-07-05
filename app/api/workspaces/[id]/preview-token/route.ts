// Returns the per-workspace preview token to the authenticated app UI (Basic Auth protected by
// server.ts). FileViewer injects it into the opaque-origin HTML preview so the preview can call
// its own workspace backend through the proxy without the user's ambient session. See
// lib/infra/security/previewToken.ts.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { getPreviewToken } from "@/lib/infra/security/previewToken";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return Response.json({ token: getPreviewToken(id) });
}

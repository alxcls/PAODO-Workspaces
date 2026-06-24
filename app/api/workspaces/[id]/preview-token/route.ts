// Returns the per-workspace preview token to the authenticated app UI (Basic Auth protected by
// server.ts). FileViewer injects it into the opaque-origin HTML preview so the preview can call
// its own workspace backend through the proxy without the user's ambient session. See
// lib/infra/security/previewToken.ts.
export const runtime = "nodejs";

import { getStore } from "@/lib/infra/services";
import { getPreviewToken } from "@/lib/infra/security/previewToken";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getStore().getWorkspace(id)) return new Response("not found", { status: 404 });
  return Response.json({ token: getPreviewToken(id) });
}

// REST endpoint for a workspace's internet-access toggle. GET returns current state; PATCH flips it.
// PATCH also stops the running container so its network is torn down and rebuilt with the correct
// --internal flag on next use (containerManager.ts) — the toggle only becomes a real network-layer
// boundary once that happens, not merely once the setting is persisted.
//
// The wire name is `enabled` because this route is about one setting; the receipt names it
// `internetAccess`, as every other trigger does. Validation is the shared validator rather than a
// local typeof, so the rejection message is the same one a workspace PATCH or the CLI would produce.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { notFound, requireWorkspace } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { receiptResponse } from "@/lib/api/workspaceUpdateReceipt";
import { createLogger } from "@/lib/infra/logger";
import { updateWorkspace } from "@/lib/operations/workspaceUpdate";
import { validateInternetAccess } from "@/lib/operations/workspaceEgress";

const log = createLogger("api").child({ route: "internet-access" });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  return NextResponse.json({ enabled: ws.internetAccess });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;

  const body = await readJsonObject(req);
  if (body instanceof Response) return body;

  try {
    const result = await updateWorkspace(id, { internetAccess: validateInternetAccess(body.enabled) });
    // Past the guard above, a missing workspace means it was deleted mid-request.
    if (!result) return notFound(req);
    return receiptResponse(result);
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "internet_access_update_failed",
        outcome: "internet_access_not_changed",
        code: "INTERNAL_ERROR",
        err,
        workspaceId: id,
      },
      "failed to update internet access",
    );
    return errorResponse("INTERNAL_ERROR", "failed to update internet access", { request: req });
  }
}

// REST endpoint for managing a workspace's agent API key.
// GET returns current state; POST explicitly generates/rotates the key (plaintext returned once);
// DELETE revokes it; PATCH toggles the channel. Everything but GET comes from shared handlers.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { credentialHandlers, publicBaseUrl } from "@/lib/api/credentialRoutes";
import { state } from "@/lib/infra/security/credentialStore";
import { requireWorkspaceId } from "@/lib/api/guards";
import { channelSetEnabled } from "@/lib/api/workspaceUpdateReceipt";

type Params = { id: string };

const handlers = credentialHandlers<Params>(
  "workspace-api",
  // Guarded like the MCP route: an unchecked id would let a typo mint a key against a workspace that
  // does not exist, leaving an orphan credential record nothing ever cleans up.
  async ({ id }, request) => {
    const ws = requireWorkspaceId(id, request);
    return ws instanceof NextResponse ? ws : ws.id;
  },
  { setEnabled: channelSetEnabled("workspaceApiAccess") },
);

export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
export const PATCH = handlers.PATCH;

export async function GET(req: Request, { params }: { params: Promise<Params> }) {
  const { id } = await params;
  const ws = requireWorkspaceId(id, req);
  if (ws instanceof NextResponse) return ws;
  return NextResponse.json(
    { ...state("workspace-api", ws.id), publicBaseUrl: publicBaseUrl() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

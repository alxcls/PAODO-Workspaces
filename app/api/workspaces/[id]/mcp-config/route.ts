// REST endpoint for managing a workspace's MCP configuration (the settings-UI backend), kept on a
// distinct path from the MCP protocol endpoint (/mcp). GET returns state + the skills the endpoint
// exposes; PATCH toggles enabled; POST explicitly generates/rotates the bearer key (returned once);
// DELETE revokes it.
//
// The credential verbs come from the shared handlers — the MCP key is a credential like any other.
// There is deliberately no write verb for the exposed set: enabling the endpoint exposes every skill
// the workspace declares in .skills/, so the workspace agent decides that surface by authoring
// contracts and GET is a read-only view of it.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { credentialHandlers, publicBaseUrl } from "@/lib/api/credentialRoutes";
import { state } from "@/lib/infra/security/credentialStore";
import { listWorkspaceSkills } from "@/lib/operations/workspaceSkills";
import { requireWorkspaceId } from "@/lib/api/guards";
import { channelSetEnabled } from "@/lib/api/workspaceUpdateReceipt";

type Params = { id: string };

const handlers = credentialHandlers<Params>(
  "workspace-mcp",
  async ({ id }, request) => {
    const ws = requireWorkspaceId(id, request);
    return ws instanceof NextResponse ? ws : ws.id;
  },
  {
    setEnabled: channelSetEnabled("workspaceMcpAccess"),
    // Same vocabulary as the workspace projection, for the same reason as the API-key route.
    axisFields: { access: "workspaceMcpAccess", hasKey: "workspaceMcpHasKey" },
  },
);

export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
export const PATCH = handlers.PATCH;

export async function GET(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = await params;
  const ws = requireWorkspaceId(id, req);
  if (ws instanceof NextResponse) return ws;

  const exposedSkills = await listWorkspaceSkills(ws.id);
  return NextResponse.json(
    {
      ...state("workspace-mcp", ws.id),
      exposedSkills,
      publicBaseUrl: publicBaseUrl(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

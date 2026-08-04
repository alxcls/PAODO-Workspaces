// REST endpoint for managing a workspace's MCP configuration (the settings-UI backend), kept on a
// distinct path from the MCP protocol endpoint (/mcp). GET returns state + the skills the endpoint
// exposes; PATCH toggles enabled; POST mints the bearer secret (returned once); DELETE revokes it.
//
// The credential verbs come from the shared handlers — the MCP secret is a credential like any other.
// There is deliberately no write verb for the exposed set: enabling the endpoint exposes every skill
// the workspace declares in .skills/, so the workspace agent decides that surface by authoring
// contracts and GET is a read-only view of it.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { credentialHandlers, publicBaseUrl } from "@/lib/api/credentialRoutes";
import { state } from "@/lib/infra/security/credentialStore";
import { listWorkspaceSkills } from "@/lib/operations/workspaceSkills";
import { updateWorkspace } from "@/lib/operations/workspaceUpdate";
import { requireWorkspace } from "@/lib/api/guards";
import { errorResponse } from "@/lib/api/errorResponse";
import type { Workspace } from "@/lib/workspace/workspaceStore";

type Params = { id: string };

function guard(id: string): Workspace | NextResponse {
  return requireWorkspace(id);
}

const handlers = credentialHandlers<Params>(
  "workspace-mcp",
  async ({ id }, request) => {
    const ws = requireWorkspace(id, request);
    return ws instanceof NextResponse ? ws : id;
  },
  {
    setEnabled: async (_kind, subject, enabled) => {
      const result = await updateWorkspace(subject as string, { workspaceMcpAccess: enabled });
      if (!result) return errorResponse("NOT_FOUND", "not found");
      // Enabling a channel that had no secret mints its first one. Hand it back here or it is lost:
      // the store keeps only a hash, so this response is the single chance to read it.
      const plain = result.credentials?.workspaceMcpSecret;
      if (plain) {
        return NextResponse.json({ ok: true, plain }, { headers: { "Cache-Control": "no-store" } });
      }
    },
  },
);

export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
export const PATCH = handlers.PATCH;

export async function GET(_req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = await params;
  const ws = guard(id);
  if (ws instanceof NextResponse) return ws;

  const exposedSkills = await listWorkspaceSkills(id);
  return NextResponse.json(
    {
      ...state("workspace-mcp", id),
      exposedSkills,
      publicBaseUrl: publicBaseUrl(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

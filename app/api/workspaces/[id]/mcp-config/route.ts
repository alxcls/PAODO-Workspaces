// REST endpoint for managing a workspace's MCP configuration (the settings-UI backend), kept on a
// distinct path from the MCP protocol endpoint (/mcp). GET returns state + the skills available to
// select; PATCH toggles enabled; POST mints the bearer secret (returned once); DELETE revokes it;
// PUT sets the selected (published) skill ids.
//
// The credential verbs come from the shared handlers — the MCP secret is a credential like any other.
// Only the skill selection is specific to MCP, so only that stays here.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { credentialHandlers, publicBaseUrl } from "@/lib/api/credentialRoutes";
import { state } from "@/lib/infra/security/credentialStore";
import { getSelectedSkills, setSelectedSkills } from "@/lib/infra/security/mcpSkillStore";
import { loadSkills } from "@/lib/workspace/skillStore";
import { requireWorkspace } from "@/lib/api/guards";
import type { Workspace } from "@/lib/workspace/workspaceStore";

type Params = { id: string };

function guard(id: string): Workspace | NextResponse {
  return requireWorkspace(id);
}

const handlers = credentialHandlers<Params>("workspace-mcp", async ({ id }) => {
  const ws = guard(id);
  return ws instanceof NextResponse ? ws : id;
});

export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
export const PATCH = handlers.PATCH;

async function jsonBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = await params;
  const ws = guard(id);
  if (ws instanceof NextResponse) return ws;

  const availableSkills = (await loadSkills(ws.dir)).map((s) => ({
    id: s.id,
    description: s.description,
  }));
  return NextResponse.json(
    {
      ...state("workspace-mcp", id),
      selectedSkillIds: getSelectedSkills(id),
      availableSkills,
      publicBaseUrl: publicBaseUrl(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = await params;
  const ws = guard(id);
  if (ws instanceof NextResponse) return ws;

  const body = await jsonBody(req);
  const selectedSkillIds = body?.selectedSkillIds;
  if (!Array.isArray(selectedSkillIds) || !selectedSkillIds.every((s) => typeof s === "string")) {
    return NextResponse.json({ error: "selectedSkillIds must be an array of strings" }, { status: 400 });
  }
  // Only persist ids that currently exist as skills, so a stale selection can't linger.
  const existing = new Set((await loadSkills(ws.dir)).map((s) => s.id));
  setSelectedSkills(
    id,
    (selectedSkillIds as string[]).filter((s) => existing.has(s)),
  );
  return NextResponse.json({ ok: true });
}

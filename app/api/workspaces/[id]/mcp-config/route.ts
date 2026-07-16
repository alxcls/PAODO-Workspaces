// REST endpoint for managing a workspace's MCP configuration (the settings-UI backend), kept on a
// distinct path from the MCP protocol endpoint (/mcp). GET returns state + the skills available to
// select; PATCH toggles enabled; POST mints the bearer secret (returned once); DELETE revokes it;
// PUT sets the selected (published) skill ids.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getState, setEnabled, mintSecret, revokeSecret, setSelectedSkills } from "@/lib/infra/security/mcpConfigStore";
import { loadSkills } from "@/lib/workspace/skillStore";
import { requireWorkspace } from "@/lib/api/guards";
import type { Workspace } from "@/lib/workspace/workspaceStore";

async function guard(id: string): Promise<Workspace | Response> {
  return requireWorkspace(id);
}

async function jsonBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = await guard(id);
  if (ws instanceof Response) return ws;

  const { enabled, secretHash, selectedSkillIds } = getState(id);
  const availableSkills = (await loadSkills(ws.dir)).map((s) => ({
    id: s.id,
    description: s.description,
  }));
  const publicBaseUrl = process.env.WORKSPACE_API_DOMAIN?.trim()
    ? `https://${process.env.WORKSPACE_API_DOMAIN.trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/+$/, "")}`
    : null;
  return NextResponse.json({
    enabled,
    hasSecret: secretHash !== null,
    selectedSkillIds,
    availableSkills,
    publicBaseUrl,
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = await guard(id);
  if (ws instanceof Response) return ws;

  const body = await jsonBody(req);
  const enabled = body?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  setEnabled(id, enabled);
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = await guard(id);
  if (ws instanceof Response) return ws;

  const plain = mintSecret(id);
  return NextResponse.json({ plain });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = await guard(id);
  if (ws instanceof Response) return ws;

  revokeSecret(id);
  return NextResponse.json({ ok: true });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = await guard(id);
  if (ws instanceof Response) return ws;

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

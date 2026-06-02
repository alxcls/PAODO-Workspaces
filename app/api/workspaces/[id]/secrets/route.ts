// REST endpoint for a workspace's secrets (env vars injected into secured scripts only).
// GET lists key NAMES only — values are write-only and never returned to the frontend.
// PUT sets/overwrites a secret; DELETE removes one. Secrets are injected at secured-script run
// time (docker exec -u root -e ...), never into the agent's own execute_command shell.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { setSecret, deleteSecret, listSecretNames, isValidSecretName } from "@/lib/infra/secretStore";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getWorkspace(id)) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  return NextResponse.json({ names: listSecretNames(id) });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getWorkspace(id)) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const { name, value } = (await req.json()) as { name?: string; value?: string };
  if (!name || !isValidSecretName(name)) {
    return NextResponse.json(
      { error: "invalid secret name — must match [A-Z_][A-Z0-9_]*" },
      { status: 400 }
    );
  }
  if (typeof value !== "string") {
    return NextResponse.json({ error: "value required" }, { status: 400 });
  }
  setSecret(id, name, value);
  return NextResponse.json({ ok: true, names: listSecretNames(id) });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getWorkspace(id)) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const { name } = (await req.json()) as { name?: string };
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  deleteSecret(id, name);
  return NextResponse.json({ ok: true, names: listSecretNames(id) });
}

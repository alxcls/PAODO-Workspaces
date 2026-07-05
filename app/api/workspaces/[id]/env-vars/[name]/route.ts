import { type NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { deleteSecret, getWorkspaceRules } from "@/lib/infra/security/workspaceSecretStore";
import { getCredentialProxy } from "@/lib/infra/proxy";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const deleted = deleteSecret(id, name);
  if (deleted) getCredentialProxy().setRules(id, getWorkspaceRules(id));

  return NextResponse.json({ ok: deleted });
}

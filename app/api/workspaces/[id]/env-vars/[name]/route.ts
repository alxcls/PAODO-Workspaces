import { type NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/infra/services";
import { deleteSecret, getWorkspaceRules } from "@/lib/infra/security/workspaceSecretStore";
import { getCredentialProxy } from "@/lib/infra/proxy";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await params;
  if (!getStore().getWorkspace(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const deleted = deleteSecret(id, name);
  if (deleted) getCredentialProxy().setRules(id, getWorkspaceRules(id));

  return NextResponse.json({ ok: deleted });
}

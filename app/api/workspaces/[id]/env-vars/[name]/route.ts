import { type NextRequest, NextResponse } from "next/server";
import { notFound } from "@/lib/api/guards";
import { deleteWorkspaceSecret } from "@/lib/operations/workspace/secrets";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await params;
  const deleted = deleteWorkspaceSecret(id, name);
  if (deleted === null) return notFound(req);
  return NextResponse.json({ ok: deleted }, { headers: { "Cache-Control": "no-store" } });
}

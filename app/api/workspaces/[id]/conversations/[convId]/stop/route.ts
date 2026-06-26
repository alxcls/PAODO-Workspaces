// Explicitly stop a conversation's in-flight run. The runner observes the abort, finishes its
// current atomic turn (so history stays valid), and exits.
import type { NextRequest } from "next/server";
import { getStore } from "@/lib/infra/services";
import * as broker from "@/lib/agent/runBroker";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id, convId } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return new Response("Workspace not found", { status: 404 });

  const stopped = broker.stop(id, convId);
  return Response.json({ stopped });
}

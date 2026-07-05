// Explicitly stop a conversation's in-flight run. The runner observes the abort, finishes its
// current atomic turn (so history stays valid), and exits.
import { type NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import * as broker from "@/lib/agent/runBroker";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id, convId } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const stopped = broker.stop(id, convId);
  return Response.json({ stopped });
}

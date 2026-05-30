import { NextResponse } from "next/server";
import { getGraph, saveGraph } from "@/lib/infra/workspaceGraph";
import type { GraphEdge } from "@/lib/infra/workspaceGraph";

function graphEnabled() {
  return process.env.GRAPH_ENABLED === "true";
}

export function GET() {
  if (!graphEnabled())
    return NextResponse.json({ error: "Graph feature is disabled" }, { status: 404 });
  return NextResponse.json(getGraph());
}

export async function PUT(req: Request) {
  if (!graphEnabled())
    return NextResponse.json({ error: "Graph feature is disabled" }, { status: 404 });
  const body = (await req.json()) as {
    edges: GraphEdge[];
    positions: Record<string, { x: number; y: number }>;
  };
  try {
    saveGraph(body.edges ?? [], body.positions ?? {});
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

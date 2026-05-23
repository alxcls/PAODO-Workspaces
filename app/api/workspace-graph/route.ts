import { NextResponse } from "next/server";
import { getGraph, saveGraph } from "@/lib/infra/workspaceGraph";
import type { GraphEdge } from "@/lib/infra/workspaceGraph";

export function GET() {
  return NextResponse.json(getGraph());
}

export async function PUT(req: Request) {
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

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
  saveGraph(body.edges ?? [], body.positions ?? {});
  return NextResponse.json({ ok: true });
}

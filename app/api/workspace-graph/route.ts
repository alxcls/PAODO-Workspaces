// CRUD endpoint for the per-workspace agent graph (nodes + edges); guarded by the GRAPH_ENABLED flag.
import { NextResponse } from "next/server";
import { getGraph, saveGraph } from "@/lib/workspace/workspaceGraph";
import type { GraphEdge } from "@/lib/workspace/workspaceGraph";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api");

function graphEnabled() {
  return process.env.GRAPH_ENABLED !== "false";
}

export function GET() {
  if (!graphEnabled()) return NextResponse.json({ error: "Graph feature is disabled" }, { status: 404 });
  return NextResponse.json(getGraph());
}

export async function PUT(req: Request) {
  if (!graphEnabled()) return NextResponse.json({ error: "Graph feature is disabled" }, { status: 404 });
  const body = (await req.json()) as {
    edges: GraphEdge[];
    positions: Record<string, { x: number; y: number }>;
  };
  const edges = body.edges ?? [];
  try {
    saveGraph(edges, body.positions ?? {});
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("Graph contains a cycle")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    log.error({ err: e, route: "workspace-graph" }, "failed to save workspace graph");
    return NextResponse.json({ error: "failed to save workspace graph" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

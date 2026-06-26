// CRUD endpoint for the per-workspace agent graph (nodes + edges); guarded by the GRAPH_ENABLED flag.
import { NextResponse } from "next/server";
import { getGraph, saveGraph } from "@/lib/workspace/workspaceGraph";
import type { GraphEdge } from "@/lib/workspace/workspaceGraph";
import { getWorkspace } from "@/lib/workspace/workspaceStore";
import { scaffoldCalleeSkills } from "@/lib/workspace/workspaceScaffold";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("workspace-graph");

function graphEnabled() {
  return process.env.GRAPH_ENABLED !== "false";
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
  const edges = body.edges ?? [];
  try {
    saveGraph(edges, body.positions ?? {});
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  // Every workspace that is now a callee (an edge target) gets its skills/ folder seeded.
  // Idempotent and best-effort — a scaffold failure must not fail the graph save.
  await Promise.all(
    [...new Set(edges.map((e) => e.target))].map(async (id) => {
      const ws = getWorkspace(id);
      if (!ws) return;
      try {
        await scaffoldCalleeSkills(ws.dir);
      } catch (e) {
        log.warn({ workspaceId: id, err: (e as Error).message }, "scaffoldCalleeSkills failed");
      }
    }),
  );
  return NextResponse.json({ ok: true });
}

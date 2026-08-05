// REST endpoint for drive↔workspace connections.
// GET lists all connections; POST connects a drive to a workspace; DELETE removes a connection.
// Kept separate from the agent-call graph so drive links never leak into list_agents/call_agent.
import { NextRequest, NextResponse } from "next/server";
import { listConnections, connectDrive, disconnectDrive, getDrive } from "@/lib/drives/store";
import { getStore } from "@/lib/infra/services";

export function GET() {
  return NextResponse.json(listConnections());
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    driveId?: string;
    workspaceId?: string;
    sourceHandle?: string;
    targetHandle?: string;
  };
  if (!body.driveId || !body.workspaceId) {
    return NextResponse.json({ error: "driveId and workspaceId are required" }, { status: 400 });
  }
  if (!getDrive(body.driveId)) return NextResponse.json({ error: "drive not found" }, { status: 404 });
  if (!getStore().getWorkspace(body.workspaceId)) {
    return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  }
  const connection = connectDrive(body.driveId, body.workspaceId, {
    sourceHandle: body.sourceHandle,
    targetHandle: body.targetHandle,
  });
  return NextResponse.json(connection, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const body = (await req.json()) as { connectionId?: string };
  if (!body.connectionId) return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
  const deleted = disconnectDrive(body.connectionId);
  return NextResponse.json({ deleted });
}

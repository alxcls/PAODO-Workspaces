import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    graphEnabled: process.env.GRAPH_ENABLED === "true",
  });
}

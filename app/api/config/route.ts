// Exposes feature flags (e.g. GRAPH_ENABLED) to the client so the UI can conditionally render optional features.
import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    graphEnabled: process.env.GRAPH_ENABLED !== "false",
  });
}

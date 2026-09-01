// Disk usage for the filesystem holding WORKSPACES_ROOT, powering the settings storage bar.
//
// getDiskUsage reports the mount the path lives on, which on the VPS is the data volume. When the path
// is missing (e.g. running next outside the container) statfs throws and we return available:false
// rather than an error, so the UI degrades to "unavailable" instead of showing a failure.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDiskUsage } from "@/lib/infra/storage/diskSpace";
import { WORKSPACES_ROOT } from "@/lib/infra/paths";

export async function GET() {
  try {
    const usage = await getDiskUsage(WORKSPACES_ROOT);
    return NextResponse.json(
      { available: true, ...usage },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ available: false }, { headers: { "Cache-Control": "no-store" } });
  }
}

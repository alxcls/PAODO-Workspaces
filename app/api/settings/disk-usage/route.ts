// Disk usage for the filesystem holding WORKSPACES_ROOT, powering the settings storage bar.
//
// statfs reports the mount the path lives on, which on the VPS is the data volume. When the path is
// missing (e.g. running next outside the container) it returns available:false rather than an error,
// so the UI degrades to "unavailable" instead of showing a failure.
export const runtime = "nodejs";

import { statfs } from "node:fs/promises";
import { NextResponse } from "next/server";
import { WORKSPACES_ROOT } from "@/lib/infra/paths";

export async function GET() {
  try {
    const fs = await statfs(WORKSPACES_ROOT);
    const used = (fs.blocks - fs.bfree) * fs.bsize;
    const free = fs.bavail * fs.bsize;
    const total = used + free;
    return NextResponse.json(
      { available: true, total, used, free },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ available: false }, { headers: { "Cache-Control": "no-store" } });
  }
}

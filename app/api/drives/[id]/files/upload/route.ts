// Handles file uploads into a shared drive directory. A folder upload arrives as one request per file.
// Drives are passive host storage: the shared upload core runs with a bare backend (no git snapshot).
export const runtime = "nodejs";
// No maxDuration here: this app runs as a custom Node server (server.ts), not on Vercel, where
// maxDuration is enforced. Request duration for uploads is governed by server.ts's
// httpServer.requestTimeout instead.

import { type NextRequest, NextResponse } from "next/server";
import { requireDrive, rateLimited } from "@/lib/api/guards";
import { driveContentDir } from "@/lib/workspace/driveStore";
import { handleUpload } from "@/lib/workspace/fileUpload";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const limited = rateLimited(req, { policy: "upload", scope: id, logContext: { driveId: id } });
  if (limited) return limited;

  const drive = requireDrive(id);
  if (drive instanceof NextResponse) return drive;

  return handleUpload(req, { dir: driveContentDir(id), logContext: { driveId: id } });
}

// Returns a shared drive's file tree as nested JSON, for the file tree panel and for `paodo drive
// file ls`.
//
// The query string it reads and what it answers with are lib/api/fileTreeRoutes.ts, shared with the
// workspace route. It used to call buildTree directly, which meant no `?path=`, no `?depth=` and no
// `?measure=`: enough for a panel that renders a whole tree at once, and not enough for a client that
// navigates one level at a time or sizes a read window before making it.
import { NextResponse } from "next/server";
import { requireDrive } from "@/lib/api/guards";
import { driveContentDir } from "@/lib/drives/store";
import { getFileTree } from "@/lib/api/fileTreeRoutes";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id, req);
  if (drive instanceof NextResponse) return drive;
  return getFileTree(req, { dir: driveContentDir(id), logContext: { driveId: id, route: "drive-files" } });
}

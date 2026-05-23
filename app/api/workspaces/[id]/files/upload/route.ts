// Handles file uploads into a workspace directory, enforcing a 100 MB size limit and rate limiting.
// The target path is supplied as a query parameter and validated to prevent writes outside the workspace.
export const runtime = "nodejs";
export const maxDuration = 120;

import { type NextRequest, NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { checkRateLimit } from "@/lib/infra/rateLimit";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    const { id } = await params;
    createLogger("api").warn({ workspaceId: id, ip }, "rate limit exceeded");
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    });
  }

  // Reject early if Content-Length already exceeds the limit
  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 100 MB)" }, { status: 413 });
  }

  const { id } = await params;
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const wsDir = await fs.realpath(ws.dir);
  let resolved: string;
  try {
    resolved = await fs.realpath(path.resolve(wsDir, filePath));
  } catch {
    const parentReal = await fs.realpath(path.dirname(path.resolve(wsDir, filePath)));
    resolved = path.join(parentReal, path.basename(filePath));
  }
  if (!resolved.startsWith(wsDir + path.sep))
    return NextResponse.json({ error: "invalid path" }, { status: 400 });

  const buf = Buffer.from(await req.arrayBuffer());

  // Double-check after reading (Content-Length can be absent or spoofed)
  if (buf.length > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 100 MB)" }, { status: 413 });
  }

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, buf);
  } catch (err) {
    createLogger("api").error({ err, workspaceId: id, filePath }, "failed to write uploaded file");
    return NextResponse.json({ error: "failed to write file" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

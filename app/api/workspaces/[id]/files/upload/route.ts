// Handles file uploads into a workspace directory.
// Single-file mode: path supplied as query param, 100 MB limit.
// Archive mode: Content-Type application/zip, extracts all entries, 500 MB limit.
export const runtime = "nodejs";
export const maxDuration = 120;

import { type NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/infra/services";
import { checkRateLimit } from "@/lib/infra/security/rateLimit";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import { createLogger } from "@/lib/infra/logger";

const MAX_BYTES = 100 * 1024 * 1024;       // 100 MB — single file
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024; // 500 MB — ZIP archive

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip, { max: 200, bucket: "upload" });
  if (!rl.ok) {
    const { id } = await params;
    createLogger("api").warn({ workspaceId: id, ip }, "rate limit exceeded");
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfter) },
    });
  }

  const isZip = req.headers.get("content-type") === "application/zip";
  const sizeLimit = isZip ? MAX_ARCHIVE_BYTES : MAX_BYTES;

  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > sizeLimit) {
    return NextResponse.json(
      { error: `Payload too large (max ${isZip ? "500" : "100"} MB)` },
      { status: 413 }
    );
  }

  const { id } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const wsDir = await fs.realpath(ws.dir);
  const buf = Buffer.from(await req.arrayBuffer());

  if (buf.length > sizeLimit) {
    return NextResponse.json(
      { error: `Payload too large (max ${isZip ? "500" : "100"} MB)` },
      { status: 413 }
    );
  }

  // ---- ZIP archive upload ----
  if (isZip) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch {
      return NextResponse.json({ error: "invalid ZIP archive" }, { status: 400 });
    }

    const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
    let count = 0;
    const failures: string[] = [];

    for (const [zipPath, entry] of entries) {
      const resolved = path.normalize(path.resolve(wsDir, zipPath));
      if (!resolved.startsWith(wsDir + path.sep)) {
        failures.push(zipPath);
        continue;
      }
      try {
        const content = await entry.async("nodebuffer");
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content);
        count++;
      } catch (err) {
        createLogger("api").error({ err, workspaceId: id, zipPath }, "failed to write archive entry");
        failures.push(zipPath);
      }
    }

    if (failures.length > 0) {
      return NextResponse.json({ ok: false, count, failures }, { status: 207 });
    }
    return NextResponse.json({ ok: true, count });
  }

  // ---- Single-file upload ----
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const resolved = path.normalize(path.resolve(wsDir, filePath));
  if (!resolved.startsWith(wsDir + path.sep))
    return NextResponse.json({ error: "invalid path" }, { status: 400 });

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, buf);
  } catch (err) {
    createLogger("api").error({ err, workspaceId: id, filePath }, "failed to write uploaded file");
    return NextResponse.json({ error: "failed to write file" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

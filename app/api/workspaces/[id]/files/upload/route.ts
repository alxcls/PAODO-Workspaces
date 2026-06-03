// Handles file uploads into a workspace directory.
// Single-file mode: path supplied as query param, 100 MB limit.
// Archive mode: Content-Type application/zip, extracts all entries, 500 MB limit.
export const runtime = "nodejs";
export const maxDuration = 120;

import { type NextRequest, NextResponse } from "next/server";
import { getWorkspace } from "@/lib/infra/workspaceStore";
import { checkRateLimit } from "@/lib/infra/rateLimit";
import { getClientIp } from "@/lib/infra/clientIp";
import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import { createLogger } from "@/lib/infra/logger";
import { ensureContainer, dockerExec } from "@/lib/infra/containerManager";

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
  const ws = getWorkspace(id);
  if (!ws) return NextResponse.json({ error: "not found" }, { status: 404 });

  const wsDir = await fs.realpath(ws.dir);
  const buf = Buffer.from(await req.arrayBuffer());

  if (buf.length > sizeLimit) {
    return NextResponse.json(
      { error: `Payload too large (max ${isZip ? "500" : "100"} MB)` },
      { status: 413 }
    );
  }

  // Workspace dirs are developer:developer after first agent connection. The app server
  // (node, UID 1000) is "other" on those dirs and cannot write directly. Detect upfront
  // and fall back to writing through the container as developer — matching DELETE/PUT.
  const wsWritable = await fs.access(wsDir, fs.constants.W_OK).then(() => true, () => false);

  // ---- ZIP archive upload ----
  if (isZip) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buf);
    } catch {
      return NextResponse.json({ error: "invalid ZIP archive" }, { status: 400 });
    }

    const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);

    if (!wsWritable) {
      // Fallback: pipe the entire ZIP into the container and extract in one exec.
      // Running as developer so extracted files are developer-owned from the start.
      await ensureContainer(ws.id, wsDir);
      const r = await dockerExec(ws.id, wsDir,
        ["sh", "-c", "base64 -d > /tmp/u.zip && unzip -q -o /tmp/u.zip -d /workspace/ && rm /tmp/u.zip"],
        { stdin: buf.toString("base64"), user: "developer" },
      );
      if (r.code !== 0) {
        createLogger("api").error({ workspaceId: id, stderr: r.stderr }, "container ZIP extraction failed");
        return NextResponse.json({ ok: false, count: 0, failures: ["<archive>"] }, { status: 207 });
      }
      return NextResponse.json({ ok: true, count: entries.length });
    }

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
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") {
      createLogger("api").error({ err, workspaceId: id, filePath }, "failed to write uploaded file");
      return NextResponse.json({ error: "failed to write file" }, { status: 500 });
    }
    // Fallback: write through the container as developer.
    await ensureContainer(ws.id, wsDir);
    const rel = path.relative(wsDir, resolved).split(path.sep).join("/");
    const dirInContainer = `/workspace/${path.posix.dirname(rel)}`;
    const fileInContainer = `/workspace/${rel}`;
    const mk = await dockerExec(ws.id, wsDir, ["mkdir", "-p", dirInContainer], { user: "developer" });
    if (mk.code !== 0) {
      createLogger("api").error({ workspaceId: id, filePath, stderr: mk.stderr }, "container mkdir failed");
      return NextResponse.json({ error: "failed to write file" }, { status: 500 });
    }
    const wr = await dockerExec(ws.id, wsDir, ["tee", fileInContainer], { stdin: buf, user: "developer" });
    if (wr.code !== 0) {
      createLogger("api").error({ workspaceId: id, filePath, stderr: wr.stderr }, "container write failed");
      return NextResponse.json({ error: "failed to write file" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}

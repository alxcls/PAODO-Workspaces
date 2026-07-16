// Shared upload handler for the workspace and drive upload routes.
// Single-file mode: path supplied as query param, 100 MB limit.
// Archive mode: Content-Type application/zip, extracts all entries, 500 MB limit.
//
// Containment: the target directory is realpath'd once, then every write target is resolved against
// it and must stay under it (string boundary check — it does not require the path to exist yet, so
// nested ZIP directories extract correctly). The two callers differ only in the optional `afterWrite`
// git snapshot (workspaces take one; drives are passive host storage and do not).
import { type NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import { createLogger } from "@/lib/infra/logger";

const MAX_BYTES = 100 * 1024 * 1024; // 100 MB — single file
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024; // 500 MB — ZIP archive

export interface UploadBackend {
  dir: string;
  logContext: Record<string, unknown>;
  // Called after a successful upload (workspace git snapshot). `message` describes the change.
  afterWrite?: (message: string) => Promise<void>;
}

export async function handleUpload(req: NextRequest, be: UploadBackend): Promise<Response> {
  const log = createLogger("api");
  const isZip = req.headers.get("content-type") === "application/zip";
  const sizeLimit = isZip ? MAX_ARCHIVE_BYTES : MAX_BYTES;
  const tooLarge = () =>
    NextResponse.json({ error: `Payload too large (max ${isZip ? "500" : "100"} MB)` }, { status: 413 });

  const contentLength = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (contentLength > sizeLimit) return tooLarge();

  const dir = await fs.realpath(be.dir);
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > sizeLimit) return tooLarge();

  // Resolve a candidate path against the (realpath'd) backend dir, returning null if it escapes.
  const contain = (p: string): string | null => {
    const resolved = path.normalize(path.resolve(dir, p));
    return resolved.startsWith(dir + path.sep) ? resolved : null;
  };

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
      const resolved = contain(zipPath);
      if (!resolved) {
        failures.push(zipPath);
        continue;
      }
      try {
        const content = await entry.async("nodebuffer");
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content);
        count++;
      } catch (err) {
        log.error({ ...be.logContext, err, zipPath }, "failed to write archive entry");
        failures.push(zipPath);
      }
    }

    await be.afterWrite?.(`uploaded ${count} file(s)`);
    if (failures.length > 0) return NextResponse.json({ ok: false, count, failures }, { status: 207 });
    return NextResponse.json({ ok: true, count });
  }

  // ---- Single-file upload ----
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const resolved = contain(filePath);
  if (!resolved) return NextResponse.json({ error: "invalid path" }, { status: 400 });

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, buf);
  } catch (err) {
    log.error({ ...be.logContext, err, filePath }, "failed to write uploaded file");
    return NextResponse.json({ error: "failed to write file" }, { status: 500 });
  }

  await be.afterWrite?.(`uploaded ${path.basename(resolved)}`);
  return NextResponse.json({ ok: true });
}

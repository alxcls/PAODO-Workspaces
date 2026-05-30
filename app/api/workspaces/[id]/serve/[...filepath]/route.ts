// Serves workspace files by path segments so iframes can resolve relative URLs.
// Used by FileViewer's HTML preview: a <base href> pointing here lets the browser
// resolve ../banner.png etc. against the actual file-system location.
export const runtime = "nodejs";

import { getWorkspace } from "@/lib/infra/workspaceStore";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";

// Omitting allow-same-origin is intentional: it forces the page to a null origin so
// fetch() calls to the app's own API routes are cross-origin and blocked by CORS.
const SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-top-navigation-by-user-activation";

const EXT_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  xml: "application/xml",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

async function getMime(filePath: string, buf: Buffer): Promise<string> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  const { fileTypeFromBuffer } = await import("file-type");
  const result = await fileTypeFromBuffer(buf);
  return result?.mime ?? "application/octet-stream";
}

async function assertInsideWorkspace(wsDir: string, filePath: string): Promise<string> {
  const wsReal = await fs.realpath(wsDir);
  let resolved: string;
  try {
    resolved = await fs.realpath(filePath);
  } catch {
    const parentReal = await fs.realpath(path.dirname(filePath));
    resolved = path.join(parentReal, path.basename(filePath));
  }
  if (!resolved.startsWith(wsReal + path.sep) && resolved !== wsReal) {
    throw new Error("Path is outside workspace");
  }
  return resolved;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; filepath: string[] }> }
) {
  const { id, filepath } = await params;
  const ws = getWorkspace(id);
  if (!ws) return new Response("not found", { status: 404 });

  // Reconstruct the absolute path from URL path segments (Next.js already decodes them)
  const absPath = "/" + filepath.join("/");

  try {
    const resolved = await assertInsideWorkspace(ws.dir, absPath);
    const buf = await fs.readFile(resolved);
    const mime = await getMime(resolved, buf);
    const needsSandbox = mime.startsWith("text/html") || mime === "image/svg+xml";
    return new Response(buf, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-cache",
        ...(needsSandbox && { "Content-Security-Policy": SANDBOX_CSP }),
      },
    });
  } catch (err) {
    createLogger("api").debug({ err, workspaceId: id, absPath }, "serve file not found");
    return new Response("not found", { status: 404 });
  }
}

// Serves workspace files by path segments so iframes can resolve relative URLs.
// Used by FileViewer's HTML preview: a <base href> pointing here lets the browser
// resolve ../banner.png etc. against the actual file-system location.
export const runtime = "nodejs";

import { getStore } from "@/lib/infra/services";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { assertInsideWorkspace } from "@/lib/infra/workspaceContainment";

// Omitting allow-same-origin is intentional: it forces the page to a null origin so
// fetch() calls to the app's own API routes are cross-origin and blocked by CORS.
const SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals allow-top-navigation-by-user-activation";

// The opaque-origin preview reaches its own workspace's files here; grant CORS so subresources
// fetched by script resolve. `null` ACAO is safe — access is gated by the per-workspace preview
// token (validated in server.ts), not by origin, and no credentials are used.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "null",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Vary": "Origin",
};

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

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

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; filepath: string[] }> }
) {
  const { id, filepath } = await params;
  const ws = getStore().getWorkspace(id);
  if (!ws) return new Response("not found", { status: 404 });

  // First segment is the per-workspace preview token (already validated in server.ts); the rest are
  // the file's path. Carrying the token in the path lets module scripts and their nested relative
  // imports authenticate, since a path prefix survives relative-URL resolution.
  const [, ...rest] = filepath;
  // Reconstruct the absolute path from URL path segments (Next.js already decodes them)
  const absPath = "/" + rest.join("/");

  try {
    const resolved = await assertInsideWorkspace(ws.dir, absPath);
    const buf = await fs.readFile(resolved);
    const mime = await getMime(resolved, buf);
    const needsSandbox = mime.startsWith("text/html") || mime === "image/svg+xml";
    return new Response(buf, {
      headers: {
        ...CORS_HEADERS,
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

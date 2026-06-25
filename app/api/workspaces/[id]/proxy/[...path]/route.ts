// Reverse-proxies HTTP requests from the browser to the workspace container's dev server, forwarding all methods and bodies.
import { getStore, getContainers } from "@/lib/infra/services";
import { NextRequest, NextResponse } from "next/server";

type Params = { id: string; path: string[] };

// The preview iframe runs at an opaque (null) origin, so it must be granted CORS to read these
// responses. `null` ACAO is safe here because access is gated by the unguessable per-workspace
// preview token (validated in server.ts), not by origin — and no cookies/credentials are used.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "null",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Vary": "Origin",
};

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

async function handle(req: NextRequest, { params }: { params: Promise<Params> }): Promise<NextResponse> {
  const { id, path } = await params;
  const workspace = getStore().getWorkspace(id);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const port = await getContainers().getServerPort(id);
  if (!port) {
    return NextResponse.json(
      { error: "Container server port not available. Trigger any agent action to restart the container with port mapping, then retry." },
      { status: 503 },
    );
  }

  const targetPath = path.join("/");
  const search = req.nextUrl.search ?? "";
  // In production the app runs inside Docker; localhost is the container's own loopback, not the
  // host where the port is bound. host.docker.internal resolves to the host (enabled via
  // extra_hosts in docker-compose.yml). In dev the app runs directly on the host, so localhost works.
  const host = process.env.WORKSPACES_VOLUME_NAME ? "host.docker.internal" : "localhost";
  const url = `http://${host}:${port}/${targetPath}${search}`;

  let body: BodyInit | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers: { "content-type": req.headers.get("content-type") ?? "application/octet-stream" },
      body: body ?? undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return NextResponse.json({ error: "Container server unreachable. Make sure a server is running on port 8080 inside the workspace." }, { status: 502 });
  }

  const responseBody = await upstream.arrayBuffer();
  const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
  const isHtml = ct.startsWith("text/html") || ct.startsWith("image/svg");
  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: {
      ...CORS_HEADERS,
      "content-type": ct,
      "x-content-type-options": "nosniff",
      ...(isHtml && {
        "content-security-policy":
          "sandbox allow-scripts allow-forms allow-popups allow-modals allow-top-navigation-by-user-activation",
      }),
    },
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;

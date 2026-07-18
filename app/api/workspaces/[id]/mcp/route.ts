// Workspace MCP protocol endpoint (Streamable HTTP). External AI clients POST JSON-RPC here to
// discover and call the workspace's selected skills as MCP tools. Authenticated by the workspace's
// own bearer secret (mcpConfigStore), NOT the site-wide Basic Auth — the path is exempted in
// httpAuth.ts. Runs stateless with buffered JSON responses, so each POST is a self-contained
// exchange and there is no server->client SSE channel (GET/DELETE therefore return 405).
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildWorkspaceMcpServer } from "@/lib/mcp/workspaceMcpServer";
import { validateSecret } from "@/lib/infra/security/mcpConfigStore";
import { rateLimited, subjectRateLimited } from "@/lib/api/guards";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createAuditLogger, createLogger } from "@/lib/infra/logger";
import { throttleLogWithSources } from "@/lib/infra/logThrottle";

const log = createLogger("api");
const audit = createAuditLogger("api");

function bearer(req: Request): string {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

const methodNotAllowed = () =>
  Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This MCP endpoint is stateless; use POST." },
      id: null,
    },
    { status: 405 },
  );

async function requestId(req: Request): Promise<string | number | null> {
  try {
    const body: unknown = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body) && "id" in body) {
      const id = (body as { id: unknown }).id;
      if (typeof id === "string" || typeof id === "number" || id === null) return id;
    }
  } catch {
    // An invalid or unreadable body has no usable JSON-RPC id.
  }
  return null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const limited = rateLimited(req, {
    policy: "publicMcpIp",
    logContext: { workspaceId: id, route: "mcp" },
  });
  if (limited) return limited;

  if (!validateSecret(id, bearer(req))) {
    // Reachable by anyone on the internet — this is one of the two routes the public Caddy gateway
    // forwards — so the caller decides how often it logs. Per-IP rate limiting above bounds a single
    // source; the throttle is what bounds a flood spread across many.
    const ip = getClientIp(req);
    const throttled = throttleLogWithSources("mcp_auth_unauthorized", ip);
    if (throttled) {
      audit.warn(
        {
          workspaceId: id,
          route: "mcp",
          ip,
          requestId: req.headers.get("x-request-id") ?? undefined,
          event: "mcp_auth_unauthorized",
          ...throttled,
        },
        "unauthorized MCP request",
      );
    }
    return new Response("Unauthorized", { status: 401 });
  }

  const workspaceLimited = subjectRateLimited(`workspace:${id}`, "workspaceMcp", {
    logContext: { workspaceId: id, route: "mcp" },
  });
  if (workspaceLimited) return workspaceLimited;

  // Preserve a clone before the transport consumes the original request. If setup or transport
  // handling itself throws, the fallback still returns a JSON-RPC error with the caller's id.
  const requestForErrorId = req.clone();

  // Stateless: a fresh server+transport per request, no session id, buffered JSON response.
  let server: ReturnType<typeof buildWorkspaceMcpServer> | undefined;
  let transport: WebStandardStreamableHTTPServerTransport | undefined;
  try {
    server = buildWorkspaceMcpServer(id);
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    // enableJsonResponse buffers the full response before this resolves, so the exchange is
    // complete and it is safe to tear the per-request server/transport down afterward.
    return await transport.handleRequest(req);
  } catch (err) {
    log.error(
      {
        event: "workspace_mcp_request_failed",
        outcome: "jsonrpc_internal_error_returned",
        err,
        workspaceId: id,
        route: "mcp",
      },
      "workspace MCP request failed",
    );
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: await requestId(requestForErrorId) },
      { status: 500 },
    );
  } finally {
    await transport?.close().catch((err) => log.warn({ err, workspaceId: id }, "failed to close MCP transport"));
    await server?.close().catch((err) => log.warn({ err, workspaceId: id }, "failed to close MCP server"));
  }
}

export function GET() {
  return methodNotAllowed();
}

export function DELETE() {
  return methodNotAllowed();
}

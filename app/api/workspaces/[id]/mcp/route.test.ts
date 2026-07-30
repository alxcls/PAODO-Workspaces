// Route-level coverage for the public MCP boundary: rate limiting and secret validation must run
// before any MCP server is constructed, and handler failures must remain valid JSON-RPC responses.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  limited: null as Response | null,
  workspaceLimited: null as Response | null,
  validateCredential: vi.fn(() => false),
  buildServer: vi.fn(() => ({ connect: vi.fn(async () => {}), close: vi.fn(async () => {}) })),
  handleRequest: vi.fn(async (_req: Request) => Response.json({ jsonrpc: "2.0", id: 7, result: { tools: [] } })),
}));

vi.mock("@/lib/api/guards", () => ({
  rateLimited: () => h.limited,
  subjectRateLimited: () => h.workspaceLimited,
}));
vi.mock("@/lib/infra/security/credentialStore", () => ({ validate: h.validateCredential }));
vi.mock("@/lib/mcp/workspaceMcpServer", () => ({ buildWorkspaceMcpServer: h.buildServer }));
vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: class {
    async handleRequest(req: Request) {
      return h.handleRequest(req);
    }
    async close() {}
  },
}));

import { DELETE, GET, POST } from "./route";

const ctx = (id = "ws-1") => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, secret?: string) =>
  POST(
    new Request("http://x/api/workspaces/ws-1/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify(body),
    }) as never,
    ctx(),
  );

beforeEach(() => {
  h.limited = null;
  h.workspaceLimited = null;
  h.validateCredential.mockReset().mockReturnValue(false);
  h.buildServer.mockClear();
  h.handleRequest.mockClear();
});

describe("workspace MCP route", () => {
  it("rejects a missing or invalid bearer secret before constructing an MCP server", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    // The kind is part of the assertion: "workspace-mcp" is what scopes this to the MCP secret rather
    // than accepting the workspace's agent API key or the instance-wide CLI token.
    expect(h.validateCredential).toHaveBeenCalledWith("workspace-mcp", "ws-1", "");
    expect(h.buildServer).not.toHaveBeenCalled();
  });

  it("rate limits before checking the secret or constructing an MCP server", async () => {
    h.limited = new Response("Too Many Requests", { status: 429 });
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "valid");
    expect(res.status).toBe(429);
    expect(h.validateCredential).not.toHaveBeenCalled();
    expect(h.buildServer).not.toHaveBeenCalled();
  });

  it("passes an authenticated JSON-RPC request to the transport", async () => {
    h.validateCredential.mockReturnValue(true);
    const res = await post({ jsonrpc: "2.0", id: 7, method: "tools/list" }, "valid");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
    expect(h.buildServer).toHaveBeenCalledWith("ws-1");
    expect(h.handleRequest).toHaveBeenCalledOnce();
  });

  it("applies the authenticated workspace quota before constructing an MCP server", async () => {
    h.validateCredential.mockReturnValue(true);
    h.workspaceLimited = new Response("Too Many Requests", { status: 429 });
    const res = await post({ jsonrpc: "2.0", id: 7, method: "tools/list" }, "valid");
    expect(res.status).toBe(429);
    expect(h.buildServer).not.toHaveBeenCalled();
  });

  it("returns a JSON-RPC internal error if MCP setup fails", async () => {
    h.validateCredential.mockReturnValue(true);
    h.buildServer.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const res = await post({ jsonrpc: "2.0", id: "req-1", method: "tools/list" }, "valid");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal error" },
      id: "req-1",
    });
  });

  it("rejects unsupported stateless transport methods", async () => {
    expect((await GET()).status).toBe(405);
    expect((await DELETE()).status).toBe(405);
  });
});

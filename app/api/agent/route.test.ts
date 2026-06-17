// The public agent endpoint is the one management-route exception that is NOT behind the
// server-level HTTP Basic auth (server.ts exempts it), so its Bearer-API-key check is the only
// thing standing between an anonymous caller and a workspace's agent. These tests pin that
// gate — and specifically the per-workspace SCOPING invariant: a key that is valid for one
// workspace must not authenticate a request aimed at another. validateKey is keyed by
// workspace id, so the bug class is "auth passes as long as the key is valid for *some*
// workspace," which would let any tenant drive any other tenant's agent.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Two workspaces, each with its own key. validateKey is the real scoping primitive (tested in
// apiKeyStore.test.ts); here we fake it so the test owns the key→workspace mapping and these
// tests assert that the ROUTE consults it with the right workspace id.
const KEYS: Record<string, string> = { "ws-a": "key-a", "ws-b": "key-b" };
const WORKSPACES: Record<string, { id: string; name: string }> = {
  alpha: { id: "ws-a", name: "alpha" },
  beta: { id: "ws-b", name: "beta" },
};

vi.mock("@/lib/infra/security/apiKeyStore", () => ({
  validateKey: (id: string, plain: string) => KEYS[id] === plain,
}));
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspaceByName: (name: string) => WORKSPACES[name] }),
  getContainers: () => ({}),
}));
vi.mock("@/lib/infra/realtime/clientIp", () => ({ getClientIp: () => "1.2.3.4" }));
// Rate limit is a separate concern (rateLimit.ts); default it to "allowed" so it never masks an
// auth assertion. One test below flips it to confirm it short-circuits *before* auth runs.
const rateLimit = { ok: true, retryAfter: 0 };
vi.mock("@/lib/infra/security/rateLimit", () => ({ checkRateLimit: () => rateLimit }));
// makeAgentStream proceeding == auth passed. Tag the response so "did we get through?" is a
// status-code check, not a real agent run.
vi.mock("@/lib/agent/agentStream", () => ({
  makeAgentStream: () => new Response("stream", { status: 200, headers: { "x-agent-stream": "1" } }),
}));

import { POST } from "./route";

function post(body: unknown, key?: string): Promise<Response> {
  return POST(
    new Request("http://x/api/agent", {
      method: "POST",
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: JSON.stringify(body),
    }) as never,
  );
}

const reachedAgent = (res: Response) => res.headers.get("x-agent-stream") === "1";

beforeEach(() => {
  rateLimit.ok = true;
});

describe("POST /api/agent — Bearer key auth & per-workspace scoping", () => {
  it("lets a request through when the key matches the named workspace", async () => {
    const res = await post({ workspace: "alpha", message: "hi" }, "key-a");
    expect(res.status).toBe(200);
    expect(reachedAgent(res)).toBe(true);
  });

  it("401s when no Authorization header is present", async () => {
    const res = await post({ workspace: "alpha", message: "hi" });
    expect(res.status).toBe(401);
    expect(reachedAgent(res)).toBe(false);
  });

  it("401s on a wrong key", async () => {
    const res = await post({ workspace: "alpha", message: "hi" }, "not-a-key");
    expect(res.status).toBe(401);
  });

  // THE scoping test: beta's own, perfectly valid key must not authenticate a request for alpha.
  it("rejects a key that is valid for a DIFFERENT workspace (no cross-workspace reuse)", async () => {
    const res = await post({ workspace: "alpha", message: "hi" }, "key-b");
    expect(res.status).toBe(401);
    expect(reachedAgent(res)).toBe(false);
  });

  it("404s for an unknown workspace (before any auth check can succeed)", async () => {
    const res = await post({ workspace: "ghost", message: "hi" }, "key-a");
    expect(res.status).toBe(404);
  });

  it("400s on missing workspace or message", async () => {
    expect((await post({ message: "hi" }, "key-a")).status).toBe(400);
    expect((await post({ workspace: "alpha" }, "key-a")).status).toBe(400);
  });

  // Rate limiting must short-circuit before auth so a flood of bad keys can't run the auth path
  // unbounded. A 429 here (with a valid key) proves the limiter runs first.
  it("429s before auth when rate limited", async () => {
    rateLimit.ok = true; // set, then trip:
    rateLimit.ok = false;
    const res = await post({ workspace: "alpha", message: "hi" }, "key-a");
    expect(res.status).toBe(429);
    expect(reachedAgent(res)).toBe(false);
  });
});

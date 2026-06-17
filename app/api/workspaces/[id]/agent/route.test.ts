// The /workspaces/[id]/agent endpoint is the other Bearer-authenticated, Basic-auth-exempt
// route. Same gate as /api/agent, but the workspace is taken from the URL id (not the body) and
// auth is checked BEFORE the workspace is looked up. These tests pin the same scoping invariant
// — a key valid for one workspace must not authenticate another id — plus that ordering, so a
// future refactor can't accidentally leak workspace existence to an unauthenticated caller.

import { describe, it, expect, vi, beforeEach } from "vitest";

const KEYS: Record<string, string> = { "ws-a": "key-a", "ws-b": "key-b", "ws-orphan": "key-orphan" };
// Note: ws-orphan has a valid key but no workspace record — used to reach the 404 branch, which
// sits AFTER the auth check.
const WORKSPACES: Record<string, { id: string; name: string }> = {
  "ws-a": { id: "ws-a", name: "alpha" },
  "ws-b": { id: "ws-b", name: "beta" },
};

vi.mock("@/lib/infra/security/apiKeyStore", () => ({
  validateKey: (id: string, plain: string) => KEYS[id] === plain,
}));
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspace: (id: string) => WORKSPACES[id] }),
  getContainers: () => ({}),
}));
vi.mock("@/lib/infra/realtime/clientIp", () => ({ getClientIp: () => "1.2.3.4" }));
const rateLimit = { ok: true, retryAfter: 0 };
vi.mock("@/lib/infra/security/rateLimit", () => ({ checkRateLimit: () => rateLimit }));
vi.mock("@/lib/agent/agentStream", () => ({
  makeAgentStream: () => new Response("stream", { status: 200, headers: { "x-agent-stream": "1" } }),
}));

import { POST } from "./route";

function post(id: string, body: unknown, key?: string): Promise<Response> {
  return POST(
    new Request(`http://x/api/workspaces/${id}/agent`, {
      method: "POST",
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) },
  );
}

const reachedAgent = (res: Response) => res.headers.get("x-agent-stream") === "1";

beforeEach(() => {
  rateLimit.ok = true;
});

describe("POST /api/workspaces/[id]/agent — Bearer key auth & per-workspace scoping", () => {
  it("lets a request through when the key matches the path workspace id", async () => {
    const res = await post("ws-a", { message: "hi" }, "key-a");
    expect(res.status).toBe(200);
    expect(reachedAgent(res)).toBe(true);
  });

  it("401s when no Authorization header is present", async () => {
    const res = await post("ws-a", { message: "hi" });
    expect(res.status).toBe(401);
    expect(reachedAgent(res)).toBe(false);
  });

  it("401s on a wrong key", async () => {
    const res = await post("ws-a", { message: "hi" }, "not-a-key");
    expect(res.status).toBe(401);
  });

  // Scoping: beta's valid key must not authenticate the ws-a endpoint.
  it("rejects a key that is valid for a DIFFERENT workspace", async () => {
    const res = await post("ws-a", { message: "hi" }, "key-b");
    expect(res.status).toBe(401);
    expect(reachedAgent(res)).toBe(false);
  });

  // Ordering: an unauthenticated caller hitting an unknown id gets 401, NOT 404 — the route must
  // not reveal whether a workspace exists before the key is validated.
  it("401s (not 404) for an unknown workspace without a valid key", async () => {
    const res = await post("ws-ghost", { message: "hi" }, "key-a");
    expect(res.status).toBe(401);
  });

  // With a key that validates for the id but no workspace record behind it, we reach the 404.
  it("404s when authenticated but the workspace record is missing", async () => {
    const res = await post("ws-orphan", { message: "hi" }, "key-orphan");
    expect(res.status).toBe(404);
  });

  it("400s on a missing message", async () => {
    const res = await post("ws-a", {}, "key-a");
    expect(res.status).toBe(400);
  });

  it("429s before auth when rate limited", async () => {
    rateLimit.ok = false;
    const res = await post("ws-a", { message: "hi" }, "key-a");
    expect(res.status).toBe(429);
    expect(reachedAgent(res)).toBe(false);
  });
});

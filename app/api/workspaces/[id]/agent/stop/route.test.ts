// The public stop endpoint shares the Bearer-key gate with POST .../agent (same key, same
// per-workspace scoping) and stops the named conversation's in-flight run. These pin the auth
// scoping plus the 400/404 branches an external caller can hit.
import { describe, it, expect, vi, beforeEach } from "vitest";

const KEYS: Record<string, string> = { "ws-a": "key-a", "ws-b": "key-b" };
const h = vi.hoisted(() => ({
  stop: vi.fn((workspaceId: string, conversationId: string) =>
    workspaceId === "ws-a" ? { workspaceId, conversationId, stopped: true } : null,
  ),
}));
const stop = h.stop;

vi.mock("@/lib/infra/security/credentialStore", () => ({
  validate: (kind: string, subject: string | null, plain: string) =>
    kind === "workspace-api" && subject !== null && KEYS[subject] === plain,
}));
vi.mock("@/lib/infra/realtime/clientIp", () => ({ getClientIp: () => "1.2.3.4" }));
const rateLimit = { ok: true, retryAfter: 0, limit: 100, remaining: 99 };
vi.mock("@/lib/infra/security/rateLimit", () => ({
  checkRateLimit: () => rateLimit,
  checkRateLimitPolicy: () => rateLimit,
}));
vi.mock("@/lib/operations/conversations/manage", () => ({ stopWorkspaceConversation: h.stop }));

import { POST } from "./route";

function post(id: string, body: unknown, key?: string): Promise<Response> {
  return POST(
    new Request(`http://x/api/workspaces/${id}/agent/stop`, {
      method: "POST",
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  rateLimit.ok = true;
  stop.mockClear();
});

describe("POST /api/workspaces/[id]/agent/stop", () => {
  it("stops the named conversation with a valid key", async () => {
    const res = await post("ws-a", { conversationId: "conv-1" }, "key-a");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true, conversationId: "conv-1" });
    expect(stop).toHaveBeenCalledWith("ws-a", "conv-1");
  });

  it("401s without a key and never reaches the stop operation", async () => {
    const res = await post("ws-a", { conversationId: "conv-1" });
    expect(res.status).toBe(401);
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not let one workspace's key stop another's run", async () => {
    const res = await post("ws-a", { conversationId: "conv-1" }, "key-b");
    expect(res.status).toBe(401);
    expect(stop).not.toHaveBeenCalled();
  });

  it("400s when conversationId is missing", async () => {
    const res = await post("ws-a", {}, "key-a");
    expect(res.status).toBe(400);
    expect(stop).not.toHaveBeenCalled();
  });

  it("404s when the stop operation reports no such workspace", async () => {
    stop.mockReturnValueOnce(null);
    const res = await post("ws-a", { conversationId: "conv-1" }, "key-a");
    expect(res.status).toBe(404);
  });
});

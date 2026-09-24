// This route skips server-level Basic auth, so its Bearer key is the only gate to a workspace's agent.
// Pins per-workspace SCOPING: a key valid for one workspace must never authenticate another.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  startWorkspaceRun: vi.fn(() => ({
    workspaceId: "ws-a",
    conversationId: "conv-created",
    origin: "api",
    started: true,
  })),
}));

// Faked validate owns the key→workspace mapping, so tests prove the route asks with the right kind and id
// ("platform" would accept an instance-wide token on a workspace-scoped request).
const KEYS: Record<string, string> = { "ws-a": "key-a", "ws-b": "key-b" };
const WORKSPACES: Record<string, { id: string; name: string }> = {
  alpha: { id: "ws-a", name: "alpha" },
  beta: { id: "ws-b", name: "beta" },
};

vi.mock("@/lib/infra/security/credentialStore", () => ({
  validate: (kind: string, subject: string | null, plain: string) =>
    kind === "workspace-api" && subject !== null && KEYS[subject] === plain,
}));
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspaceByName: (name: string) => WORKSPACES[name] }),
}));
vi.mock("@/lib/infra/realtime/clientIp", () => ({ getClientIp: () => "1.2.3.4" }));
// Rate limit is a separate concern (rateLimit.ts); default it to "allowed" so it never masks an
// auth assertion. One test below flips it to confirm it short-circuits *before* auth runs.
const rateLimit = { ok: true, retryAfter: 0 };
vi.mock("@/lib/infra/security/rateLimit", () => ({
  checkRateLimit: () => rateLimit,
  checkRateLimitPolicy: () => rateLimit,
}));
vi.mock("@/lib/operations/agent/run", () => ({ startWorkspaceRun: h.startWorkspaceRun }));
vi.mock("@/lib/api/workspaceRunStream", () => ({
  apiConversationStream: () => new Response("stream", { status: 200, headers: { "x-agent-stream": "1" } }),
}));

import { POST } from "./route";
import { ExecutionCapacityReachedError } from "@/lib/agent/executionCapacity";

function postRaw(body: string, key?: string): Promise<Response> {
  return POST(
    new Request("http://x/api/agent", {
      method: "POST",
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body,
    }) as never,
  );
}

const post = (body: unknown, key?: string) => postRaw(JSON.stringify(body), key);

const reachedAgent = (res: Response) => res.headers.get("x-agent-stream") === "1";

beforeEach(() => {
  rateLimit.ok = true;
  h.startWorkspaceRun.mockClear();
  h.startWorkspaceRun.mockReturnValue({
    workspaceId: "ws-a",
    conversationId: "conv-created",
    origin: "api",
    started: true,
  });
});

describe("POST /api/agent — Bearer key auth & per-workspace scoping", () => {
  it("lets a request through when the key matches the named workspace", async () => {
    const res = await post({ workspace: "alpha", message: "hi" }, "key-a");
    expect(res.status).toBe(200);
    expect(reachedAgent(res)).toBe(true);
    expect(h.startWorkspaceRun).toHaveBeenCalledWith("ws-a", {
      prompt: "hi",
      origin: "api",
      conversation: { mode: "create" },
    });
  });

  it("returns the shared capacity error from the legacy public API", async () => {
    h.startWorkspaceRun.mockImplementationOnce(() => {
      throw new ExecutionCapacityReachedError({ active: 10, limit: 10, available: 0, atCapacity: true });
    });

    const res = await post({ workspace: "alpha", message: "hi" }, "key-a");

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "CAPACITY_REACHED" });
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

  it("400s instead of throwing on malformed JSON or non-string fields", async () => {
    const malformed = await postRaw("{not json", "key-a");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect((await post({ workspace: 42, message: "hi" }, "key-a")).status).toBe(400);
    expect((await post({ workspace: "alpha", message: ["hi"] }, "key-a")).status).toBe(400);
    expect(h.startWorkspaceRun).not.toHaveBeenCalled();
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

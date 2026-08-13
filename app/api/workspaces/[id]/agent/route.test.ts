// The /workspaces/[id]/agent endpoint is the other Bearer-authenticated, Basic-auth-exempt
// route. Same gate as /api/agent, but the workspace is taken from the URL id (not the body) and
// auth is checked BEFORE the workspace is looked up. These tests pin the same scoping invariant
// — a key valid for one workspace must not authenticate another id — plus that ordering, so a
// future refactor can't accidentally leak workspace existence to an unauthenticated caller.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  createConversation: vi.fn(() => ({ id: "conv-created" })),
  getMessages: vi.fn((): never[] | null => []),
  startRun: vi.fn(
    (): {
      alreadyRunning: boolean;
      capacityReached?: { active: number; limit: number; available: number; atCapacity: boolean };
    } => ({ alreadyRunning: false }),
  ),
  persist: vi.fn(),
}));

const KEYS: Record<string, string> = { "ws-a": "key-a", "ws-b": "key-b", "ws-orphan": "key-orphan" };
// Note: ws-orphan has a valid key but no workspace record — used to reach the 404 branch, which
// sits AFTER the auth check.
const WORKSPACES: Record<string, { id: string; name: string; maxRunMinutes: number }> = {
  "ws-a": { id: "ws-a", name: "alpha", maxRunMinutes: 25 },
  "ws-b": { id: "ws-b", name: "beta", maxRunMinutes: 10 },
};

// Asserting on the kind matters: passing "platform" here would validate an instance-wide CLI token
// against a workspace-scoped request.
vi.mock("@/lib/infra/security/credentialStore", () => ({
  validate: (kind: string, subject: string | null, plain: string) =>
    kind === "workspace-api" && subject !== null && KEYS[subject] === plain,
}));
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspace: (id: string) => WORKSPACES[id] }),
}));
vi.mock("@/lib/infra/realtime/clientIp", () => ({ getClientIp: () => "1.2.3.4" }));
const rateLimit = { ok: true, retryAfter: 0 };
vi.mock("@/lib/infra/security/rateLimit", () => ({
  checkRateLimit: () => rateLimit,
  checkRateLimitPolicy: () => rateLimit,
}));
vi.mock("@/lib/conversations/store", () => ({
  createConversation: h.createConversation,
  getMessages: h.getMessages,
  persist: h.persist,
}));
vi.mock("@/lib/agent/runBroker", () => ({
  startRun: h.startRun,
  subscribe: () => ({ replay: [{ type: "done" }], status: "done", unsubscribe: vi.fn() }),
}));
// These prompt mocks intercept the shared workspacePrompt helper one layer below the operation.
vi.mock("@/lib/agent/systemPrompt", () => ({ buildSystemPrompt: () => "system", buildPromptConfig: () => ({}) }));
vi.mock("@/lib/agent/promptContext", () => ({ buildWorkspacePromptInputs: () => ({}) }));
vi.mock("@/lib/agent/buildTools", () => ({ loadAgentConfig: () => ({}) }));
vi.mock("@/lib/agent/messageSerialization", () => ({ setSystemPrompt: vi.fn() }));

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

const reachedAgent = (res: Response) => res.headers.get("x-conversation-id") !== null;

beforeEach(() => {
  rateLimit.ok = true;
  h.createConversation.mockClear();
  h.getMessages.mockClear();
  h.startRun.mockClear();
  h.persist.mockClear();
  h.getMessages.mockReturnValue([]);
  h.startRun.mockReturnValue({ alreadyRunning: false });
});

describe("POST /api/workspaces/[id]/agent — Bearer key auth & per-workspace scoping", () => {
  it("lets a request through when the key matches the path workspace id", async () => {
    const res = await post("ws-a", { message: "hi" }, "key-a");
    expect(res.status).toBe(200);
    expect(reachedAgent(res)).toBe(true);
    expect(res.headers.get("x-conversation-id")).toBe("conv-created");
    expect(h.createConversation).toHaveBeenCalledWith("ws-a", { kind: undefined });
    expect(h.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-created",
        userInput: "hi",
        maxRunMinutes: 25,
        origin: "api",
      }),
    );
  });

  it("continues an explicitly supplied conversation instead of creating another", async () => {
    const res = await post("ws-a", { message: "again", conversationId: "conv-existing" }, "key-a");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-conversation-id")).toBe("conv-existing");
    expect(h.createConversation).not.toHaveBeenCalled();
    expect(h.startRun).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-existing" }));
  });

  it("returns the shared not-found envelope for a missing explicit conversation", async () => {
    h.getMessages.mockReturnValueOnce(null);

    const res = await post("ws-a", { message: "again", conversationId: "conv-gone" }, "key-a");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, code: "NOT_FOUND", error: "Conversation not found" });
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it("keeps the plain-text 409 when that conversation already has a run", async () => {
    h.startRun.mockReturnValueOnce({ alreadyRunning: true });

    const res = await post("ws-a", { message: "again", conversationId: "conv-running" }, "key-a");

    expect(res.status).toBe(409);
    expect(await res.text()).toBe("A run is already in progress");
  });

  it("returns a machine-readable 503 when the instance execution ceiling is full", async () => {
    h.startRun.mockReturnValueOnce({
      alreadyRunning: false,
      capacityReached: { active: 10, limit: 10, available: 0, atCapacity: true },
    });

    const res = await post("ws-a", { message: "hi" }, "key-a");

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "CAPACITY_REACHED",
      error: "Execution capacity reached: 10/10 agent runs are active. This request was not started. Try again when another run finishes.",
      details: { active: 10, limit: 10, conversationId: "conv-created", origin: "api" },
    });
    expect(h.persist).toHaveBeenCalledWith("ws-a", "conv-created");
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

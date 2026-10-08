import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationNotFoundError, SessionNotFoundError } from "@/lib/operations/agent/errors";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/operations/conversations/sessions", () => ({ getConversationSession: h.get }));
import { GET } from "./route";

const ctx = () => ({ params: Promise.resolve({ id: "ws-1", convId: "conv-1", sessionId: "s-1" }) });
const request = () => new Request("http://localhost/api/workspaces/ws-1/conversations/conv-1/sessions/s-1") as never;

beforeEach(() => {
  h.get.mockReset();
});

describe("conversation session route", () => {
  it("serves the session uncached", async () => {
    h.get.mockReturnValue({ session: { sessionId: "s-1", userInput: "hi", agentResponse: "hello" } });
    const res = await GET(request(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ session: { sessionId: "s-1", userInput: "hi", agentResponse: "hello" } });
    expect(h.get).toHaveBeenCalledWith("ws-1", "conv-1", "s-1");
  });

  it("answers 404 for an unknown workspace", async () => {
    h.get.mockReturnValue(null);
    expect((await GET(request(), ctx())).status).toBe(404);
  });

  it.each([new ConversationNotFoundError("conv-1"), new SessionNotFoundError("s-1")])(
    "answers the app's NOT_FOUND for %s",
    async (error) => {
      h.get.mockImplementation(() => {
        throw error;
      });
      const res = await GET(request(), ctx());
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
    },
  );
});

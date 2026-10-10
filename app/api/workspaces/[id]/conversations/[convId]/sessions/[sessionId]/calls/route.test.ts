import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationNotFoundError, SessionNotFoundError } from "@/lib/operations/agent/errors";

const h = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/operations/conversations/calls", () => ({ listConversationSessionCalls: h.list }));
import { GET } from "./route";

const ctx = () => ({ params: Promise.resolve({ id: "ws-1", convId: "conv-1", sessionId: "s-1" }) });
const request = () =>
  new Request("http://localhost/api/workspaces/ws-1/conversations/conv-1/sessions/s-1/calls") as never;

beforeEach(() => {
  h.list.mockReset();
});

describe("session calls route", () => {
  it("serves the calls uncached", async () => {
    h.list.mockReturnValue({ calls: [{ callId: "k-1", tool: "file_read", inputChars: 20, outputChars: 300 }] });
    const res = await GET(request(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      calls: [{ callId: "k-1", tool: "file_read", inputChars: 20, outputChars: 300 }],
    });
    expect(h.list).toHaveBeenCalledWith("ws-1", "conv-1", "s-1");
  });

  it("answers 404 for an unknown workspace", async () => {
    h.list.mockReturnValue(null);
    expect((await GET(request(), ctx())).status).toBe(404);
  });

  it.each([new ConversationNotFoundError("conv-1"), new SessionNotFoundError("s-1")])(
    "answers the app's NOT_FOUND for %s",
    async (error) => {
      h.list.mockImplementation(() => {
        throw error;
      });
      const res = await GET(request(), ctx());
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
    },
  );
});

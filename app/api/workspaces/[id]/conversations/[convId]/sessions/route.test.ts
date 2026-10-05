import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationNotFoundError } from "@/lib/operations/agent/errors";

const h = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/operations/conversations/sessions", () => ({ listConversationSessions: h.list }));
import { GET } from "./route";

const ctx = () => ({ params: Promise.resolve({ id: "ws-1", convId: "conv-1" }) });
const request = () => new Request("http://localhost/api/workspaces/ws-1/conversations/conv-1/sessions") as never;

beforeEach(() => {
  h.list.mockReset();
});

describe("conversation sessions route", () => {
  it("serves the rows uncached", async () => {
    h.list.mockReturnValue({ sessions: [{ sessionId: "s1" }] });
    const res = await GET(request(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ sessions: [{ sessionId: "s1" }] });
    expect(h.list).toHaveBeenCalledWith("ws-1", "conv-1");
  });

  it("answers 404 for an unknown workspace", async () => {
    h.list.mockReturnValue(null);
    expect((await GET(request(), ctx())).status).toBe(404);
  });

  it("answers the app's NOT_FOUND for an unknown conversation", async () => {
    h.list.mockImplementation(() => {
      throw new ConversationNotFoundError("conv-1");
    });
    const res = await GET(request(), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

// Translation only: the statuses, and that the operation's own refusal reaches the caller unreworded.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors/appError";

const h = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn() }));

vi.mock("@/lib/operations/connections/resolve", () => ({ connect: h.connect, disconnect: h.disconnect }));

import { POST } from "./route";
import { DELETE } from "./[id]/route";

const CALL = {
  kind: "call",
  id: "call_9b2f0f4e-0000-4000-8000-000000000000",
  caller: { id: "ws-1", name: "Sales" },
  callee: { id: "ws-2", name: "Billing" },
};

const post = (body: unknown) =>
  new Request("http://x/api/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

const del = (id: string) =>
  DELETE(new Request(`http://x/api/connections/${id}`, { method: "DELETE" }) as never, {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  h.connect.mockReset().mockReturnValue(CALL);
  h.disconnect.mockReset().mockReturnValue({ deleted: true });
});

describe("POST /api/connections", () => {
  it("answers 201 with what was made", async () => {
    const response = await POST(post({ from: "ws-1", to: "ws-2" }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(CALL);
    expect(h.connect).toHaveBeenCalledWith({ from: "ws-1", to: "ws-2" });
  });

  it("relays the operation's own refusal", async () => {
    h.connect.mockImplementation(() => {
      throw new AppError("INVALID_REQUEST", "two drives cannot be connected", { field: "to" });
    });

    const response = await POST(post({ from: "dr-1", to: "dr-2" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "INVALID_REQUEST",
      error: "two drives cannot be connected",
    });
  });
});

describe("DELETE /api/connections/{id}", () => {
  it("answers with whether anything was removed", async () => {
    const response = await del(CALL.id);

    expect(await response.json()).toEqual({ deleted: true });
    expect(h.disconnect).toHaveBeenCalledWith(CALL.id);
  });

  it("relays a refused id as 400, not as deleted: false", async () => {
    h.disconnect.mockImplementation(() => {
      throw new AppError("INVALID_REQUEST", "ws-1 is not a connection id", { field: "connectionId" });
    });

    const response = await del("ws-1");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });
});

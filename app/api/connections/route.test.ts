// Translation only: the statuses, and that the operation's own refusal reaches the caller unreworded.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors/appError";

const h = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn(), connectionListing: vi.fn() }));

vi.mock("@/lib/operations/connections/resolve", () => ({ connect: h.connect, disconnect: h.disconnect }));

vi.mock("@/lib/operations/connections/list", () => ({ connectionListing: h.connectionListing }));

import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { DELETE } from "./[id]/route";

const CALL = {
  kind: "call",
  id: "call_9b2f0f4e-0000-4000-8000-000000000000",
  caller: { id: "ws-1", name: "Sales" },
  callee: { id: "ws-2", name: "Billing" },
};

const LISTING = { driveLinks: [], agentCalls: [CALL] };

const get = (query = "") => GET(new NextRequest(`http://x/api/connections${query}`));

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
  h.connectionListing.mockReset().mockReturnValue(LISTING);
});

describe("GET /api/connections", () => {
  it("answers with every connection when no id is named", async () => {
    const response = get();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(LISTING);
    expect(h.connectionListing).toHaveBeenCalledWith(undefined);
  });

  it("hands the operation the id named by ?for=", () => {
    get("?for=ws-1");

    expect(h.connectionListing).toHaveBeenCalledWith("ws-1");
  });

  it("hands an empty ?for= over as given, for the operation to refuse", () => {
    get("?for=");

    expect(h.connectionListing).toHaveBeenCalledWith("");
  });

  it("relays an unknown id as 404", async () => {
    h.connectionListing.mockImplementation(() => {
      throw new AppError("NOT_FOUND", "no workspace or drive has the id nope", { field: "for" });
    });

    const response = get("?for=nope");

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
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

import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors/appError";
import { appErrorResponse, errorResponse } from "./errorResponse";

describe("public API error contract", () => {
  it("maps a stable code to status and includes safe correlation data", async () => {
    const request = new Request("http://x/api/workspaces", {
      headers: { "x-request-id": "request-1" },
    });
    const response = errorResponse("WORKSPACE_NAME_CONFLICT", "Already exists", {
      request,
      details: { field: "name" },
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      code: "WORKSPACE_NAME_CONFLICT",
      error: "Already exists",
      details: { field: "name" },
      requestId: "request-1",
    });
  });

  it("maps expected application errors and refuses to expose unknown exceptions", async () => {
    const expected = appErrorResponse(new AppError("WORKSPACE_UPDATE_INVALID", "Bad model"));
    expect(expected?.status).toBe(400);
    expect(await expected?.json()).toEqual({
      ok: false,
      code: "WORKSPACE_UPDATE_INVALID",
      error: "Bad model",
    });
    expect(appErrorResponse(new Error("database password leaked here"))).toBeNull();
  });
});

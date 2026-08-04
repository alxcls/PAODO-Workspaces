import { describe, expect, it } from "vitest";
import { readApiError } from "./apiError";

describe("client API error parsing", () => {
  it("preserves the server's complete machine-readable failure", async () => {
    const response = Response.json(
      {
        ok: false,
        code: "WORKSPACE_NAME_CONFLICT",
        error: "Already exists",
        details: { field: "name" },
        requestId: "body-request",
      },
      { status: 409, headers: { "x-request-id": "header-request" } },
    );

    await expect(readApiError(response, "fallback")).resolves.toEqual({
      ok: false,
      code: "WORKSPACE_NAME_CONFLICT",
      error: "Already exists",
      details: { field: "name" },
      requestId: "body-request",
    });
  });

  it("falls back safely for legacy or non-JSON responses", async () => {
    const response = new Response("proxy failure", {
      status: 503,
      headers: { "x-request-id": "request-2", "content-type": "text/plain" },
    });
    await expect(readApiError(response, "Service unavailable")).resolves.toEqual({
      ok: false,
      code: "SERVICE_UNAVAILABLE",
      error: "Service unavailable",
      requestId: "request-2",
    });
  });
});

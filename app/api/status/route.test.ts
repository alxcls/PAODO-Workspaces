import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/status", () => {
  it("returns a small shared service status contract", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "ok",
      service: "PAODO",
      version: expect.any(String),
    });
  });
});

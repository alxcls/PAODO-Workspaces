// The browser half of the receipt is what every optimistic block trusts to decide whether the server
// confirmed its assumption. What matters is the degrade path: a response that carries no usable
// values must read as "nothing confirmed" so callers fall back to what they rendered, never as a
// throw that leaves the UI mid-save.
import { describe, expect, it } from "vitest";
import { confirmedValues } from "./workspaceReceipt";

const responseOf = (body: string) => new Response(body, { headers: { "content-type": "application/json" } });

describe("confirmedValues", () => {
  it("returns the canonical values a receipt carries", async () => {
    const res = responseOf(JSON.stringify({ ok: true, workspaceId: "ws-1", applied: { description: "trimmed" } }));
    expect(await confirmedValues(res)).toEqual({ description: "trimmed" });
  });

  it("reads as nothing confirmed when the body is not a receipt", async () => {
    expect(await confirmedValues(responseOf(JSON.stringify({ ok: true })))).toEqual({});
  });

  it("reads as nothing confirmed rather than throwing on a non-JSON body", async () => {
    expect(await confirmedValues(responseOf("<html>gateway</html>"))).toEqual({});
  });

  it("reads as nothing confirmed on a null body", async () => {
    expect(await confirmedValues(responseOf("null"))).toEqual({});
  });
});

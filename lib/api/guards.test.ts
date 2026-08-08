import { describe, expect, it } from "vitest";
import { workspaceIdParam } from "./guards";

const ID = "9841ce91-f521-4ddf-a966-fa5b612167bf";

describe("public workspace id contract", () => {
  it("accepts the canonical lowercase UUID used by workspace resources", () => {
    expect(workspaceIdParam(ID)).toBe(ID);
  });

  it.each([ID.toUpperCase(), "research", "9841ce91-f521-4ddf-a966-fa5b612167b"])(
    "rejects non-canonical workspace id %s before lookup",
    async (candidate) => {
      const result = workspaceIdParam(candidate);
      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) throw new Error("expected an error response");
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({
        ok: false,
        code: "INVALID_REQUEST",
        details: { field: "workspaceId" },
      });
    },
  );
});

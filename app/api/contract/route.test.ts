import { describe, expect, it } from "vitest";
import { PLATFORM_CONTRACT_VERSION } from "@/lib/infra/security/platformAccessPolicy";
import { UPDATABLE_FIELDS as DRIVE_UPDATABLE_FIELDS } from "@/lib/operations/drives/manage";
import { SCHEDULE_FIELDS } from "@/lib/operations/schedules/schedule";
import { WORKSPACE_UPDATABLE_FIELDS } from "@/lib/operations/workspace/update";
import { GET } from "./route";

describe("GET /api/contract", () => {
  it("describes exactly the fields each PATCH accepts", async () => {
    const { version, fields } = await GET().json();
    expect(version).toBe(PLATFORM_CONTRACT_VERSION);
    expect(Object.keys(fields.workspace).sort()).toEqual([...WORKSPACE_UPDATABLE_FIELDS].sort());
    expect(Object.keys(fields.schedule).sort()).toEqual([...SCHEDULE_FIELDS].sort());
    expect(Object.keys(fields.drive).sort()).toEqual([...DRIVE_UPDATABLE_FIELDS].sort());
  });

  // A client encodes by `type` alone, so a bound quoted from the validator's own constant is the proof
  // the description cannot age apart from the rule.
  it("quotes the validators' bounds and types", async () => {
    const { fields } = await GET().json();
    expect(fields.workspace.maxIterations).toEqual({ type: "int", rule: "1-500" });
    expect(fields.workspace.internetAccess).toEqual({ type: "boolean" });
    expect(fields.schedule.intervalUnit).toEqual({ type: "string", values: ["minute", "hour", "day", "week"] });
  });

  it("publishes channels, limits and vocabularies from the constants that enforce them", async () => {
    const { channels, limits, values, describe: described } = await GET().json();
    expect(channels).toEqual({ api: "api-key", mcp: "mcp-config" });
    expect(limits).toMatchObject({ listingEntries: 1000, sessionPreviewChars: 200, sessionListModelCalls: 5000 });
    expect(Object.keys(values.sessionStatus)).toContain("limit_reached");
    // A sentence quotes the limit rather than restating it, so the two cannot disagree.
    expect(described.sessionSummary.userInput).toContain(`first ${limits.sessionPreviewChars} characters`);
  });
});

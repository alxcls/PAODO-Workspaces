import { describe, it, expect } from "vitest";
import { formatSkill } from "./listAgents";
import type { SkillDefinition } from "../../workspace/skillTypes";

// The skill listing is the calling agent's ONLY view of another workspace's contract —
// if optionality or the return shape renders wrong, the caller fills in wrong args and
// burns its bounded input retries on calls the platform will reject.

describe("formatSkill", () => {
  it("renders required and optional params, description, and the return shape", () => {
    const skill: SkillDefinition = {
      id: "summarize-document",
      name: "Summarize Document",
      description: "Summarizes a document",
      parameters: {
        type: "object",
        properties: {
          drive: { type: "string" },
          path: { type: "string" },
          format: { type: "string", enum: ["bullet", "prose"] },
        },
        required: ["drive", "path"],
      },
      output: {
        type: "object",
        properties: { summary: { type: "string" }, word_count: { type: "number" } },
      },
    };
    expect(formatSkill(skill)).toBe(
      "  → summarize-document(drive: string, path: string, format?: string) — Summarizes a document\n" +
        "    returns: { summary: string, word_count: number }"
    );
  });

  it("handles a skill with no params, no description, and an empty output", () => {
    const skill: SkillDefinition = {
      id: "ping",
      name: "Ping",
      description: "",
      parameters: { type: "object" },
      output: { type: "object" },
    };
    expect(formatSkill(skill)).toBe("  → ping()\n    returns: {}");
  });
});

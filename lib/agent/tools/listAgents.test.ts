// formatSkill renders the list_agents listing — a calling agent's only view of
// another workspace's contract, so optionality and return shape must render right.

import { describe, it, expect } from "vitest";
import { formatSkill } from "./listAgents";
import type { SkillDefinition } from "../../workspace/skillTypes";

// The skill listing is the calling agent's ONLY view of another workspace's contract —
// if optionality or the return shape renders wrong, the caller fills in wrong args and
// burns its bounded input retries on calls the platform will reject.

describe("formatSkill", () => {
  it("renders required and optional params, description, return shape, and supplied examples", () => {
    const skill: SkillDefinition = {
      id: "summarize-document",
      description: "Summarizes a document",
      input: {
        type: "object",
        properties: {
          drive: { type: "string" },
          path: { type: "string" },
          format: { type: "string", enum: ["bullet", "prose"] },
        },
        required: ["drive", "path"],
        examples: [{ drive: "product-docs", path: "brief.md", format: "bullet" }],
      },
      output: {
        type: "object",
        properties: { summary: { type: "string" }, word_count: { type: "number" } },
        examples: [{ summary: "A concise brief.", word_count: 3 }],
      },
    };
    expect(formatSkill(skill)).toBe(
      "  → summarize-document(drive: string, path: string, format?: string) — Summarizes a document\n" +
        "    returns: { summary: string, word_count: number }\n" +
        '    example input: {"drive":"product-docs","path":"brief.md","format":"bullet"}\n' +
        '    example output: {"summary":"A concise brief.","word_count":3}',
    );
  });

  it("handles a skill with no params, no description, and an empty output", () => {
    const skill: SkillDefinition = {
      id: "ping",
      description: "",
      input: { type: "object" },
      output: { type: "object" },
    };
    expect(formatSkill(skill)).toBe("  → ping()\n    returns: {}");
  });
});

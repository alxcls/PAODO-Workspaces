// loadSkills reads .skills/*.json live per call; a single malformed file must be
// skipped, not throw and break skill discovery for the whole workspace.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { SKILLS_DIR, loadSkills } from "./skillStore";

// The skill list is read live from .skills/*.json on every list_agents / executeSkill
// call — there is no cached artifact to fall back on. The failure that matters is a
// single malformed file (agents write these themselves via file_write) taking down
// skill discovery for the whole workspace: each bad file must be skipped, not thrown.

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "skillstore-test-"));
const WS_DIR = path.join(ROOT, "ws");
const SKILLS = path.join(WS_DIR, SKILLS_DIR);

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(WS_DIR, { recursive: true, force: true });
  fs.mkdirSync(SKILLS, { recursive: true });
});

const VALID_SKILL = {
  id: "check-stock",
  description: "Returns inventory level",
  input: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
  output: { type: "object", properties: { in_stock: { type: "boolean" } } },
};

describe("loadSkills", () => {
  it("returns [] for a workspace with no .skills/ directory (not callable, but not an error)", async () => {
    fs.rmSync(SKILLS, { recursive: true });
    expect(await loadSkills(WS_DIR)).toEqual([]);
  });

  it("reads and parses valid skill files", async () => {
    fs.writeFileSync(path.join(SKILLS, "check-stock.json"), JSON.stringify(VALID_SKILL));
    const skills = await loadSkills(WS_DIR);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe("check-stock");
    expect(skills[0].input.required).toEqual(["sku"]);
  });

  it("does not load skills from the former non-hidden directory", async () => {
    fs.rmSync(SKILLS, { recursive: true });
    const legacy = path.join(WS_DIR, "skills");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "check-stock.json"), JSON.stringify(VALID_SKILL));

    expect(await loadSkills(WS_DIR)).toEqual([]);
  });

  it("skips malformed JSON and structurally invalid files without dropping valid ones", async () => {
    fs.writeFileSync(path.join(SKILLS, "broken.json"), "{ not json");
    fs.writeFileSync(path.join(SKILLS, "no-id.json"), JSON.stringify({ input: {}, output: {} }));
    fs.writeFileSync(path.join(SKILLS, "no-schemas.json"), JSON.stringify({ id: "x" }));
    fs.writeFileSync(path.join(SKILLS, "valid.json"), JSON.stringify(VALID_SKILL));
    fs.writeFileSync(path.join(SKILLS, "notes.txt"), "not a skill");
    const skills = await loadSkills(WS_DIR);
    expect(skills.map((s) => s.id)).toEqual(["check-stock"]);
  });

  it("skips schemas that do not explicitly declare object inputs and outputs", async () => {
    fs.writeFileSync(
      path.join(SKILLS, "missing-input-type.json"),
      JSON.stringify({
        ...VALID_SKILL,
        id: "missing-input-type",
        input: { properties: { sku: { type: "string" } } },
      }),
    );
    fs.writeFileSync(
      path.join(SKILLS, "scalar-output.json"),
      JSON.stringify({
        ...VALID_SKILL,
        id: "scalar-output",
        output: { type: "string" },
      }),
    );
    fs.writeFileSync(path.join(SKILLS, "valid.json"), JSON.stringify(VALID_SKILL));

    expect((await loadSkills(WS_DIR)).map((s) => s.id)).toEqual(["check-stock"]);
  });

  it("skips a skill whose id has characters illegal as an MCP tool name, keeping valid ones", async () => {
    fs.writeFileSync(path.join(SKILLS, "bad-id.json"), JSON.stringify({ ...VALID_SKILL, id: "check stock!" }));
    fs.writeFileSync(path.join(SKILLS, "valid.json"), JSON.stringify(VALID_SKILL));
    const skills = await loadSkills(WS_DIR);
    expect(skills.map((s) => s.id)).toEqual(["check-stock"]);
  });

  it("accepts ids using the full legal charset (alnum, underscore, hyphen)", async () => {
    fs.writeFileSync(path.join(SKILLS, "legal.json"), JSON.stringify({ ...VALID_SKILL, id: "get_Order-42" }));
    const skills = await loadSkills(WS_DIR);
    expect(skills.map((s) => s.id)).toEqual(["get_Order-42"]);
  });

  it("defaults a missing description to an empty string", async () => {
    fs.writeFileSync(
      path.join(SKILLS, "bare.json"),
      JSON.stringify({ id: "bare", input: { type: "object" }, output: { type: "object" } }),
    );
    const [skill] = await loadSkills(WS_DIR);
    expect(skill.description).toBe("");
  });
});

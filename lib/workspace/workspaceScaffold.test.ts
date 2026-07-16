// Every new workspace gets AGENTS.md plus .skills/ and its example template. The template itself
// is ignored by the loader, so a fresh workspace still has no callable skills.

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { scaffoldWorkspaceDir } from "./workspaceScaffold";
import { SKILLS_DIR, loadSkills } from "./skillStore";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-test-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("scaffoldWorkspaceDir", () => {
  it("seeds AGENTS.md and the .skills/ template", async () => {
    const dir = path.join(ROOT, "ws");
    await scaffoldWorkspaceDir(dir);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, SKILLS_DIR))).toBe(true);
    const template = path.join(dir, SKILLS_DIR, "example-skill.json.template");
    expect(fs.existsSync(template)).toBe(true);
    // The template must itself be a valid skill definition once renamed to .json.
    const parsed = JSON.parse(fs.readFileSync(template, "utf-8"));
    expect(parsed.id).toBe("example-skill");
    // Placeholder names demonstrate schema primitives without nudging toward a business domain.
    expect(parsed.input.required).toEqual(["string_field", "integer_field", "boolean_field"]);
    expect(parsed.input.properties.string_field.type).toBe("string");
    expect(parsed.input.properties.number_field).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    expect(parsed.input.properties.integer_field).toMatchObject({ type: "integer", minimum: 1, maximum: 100 });
    expect(parsed.input.properties.enum_field).toMatchObject({ type: "string", enum: ["option-a", "option-b"] });
    expect(parsed.input.properties.boolean_field.type).toBe("boolean");
    expect(parsed.input.properties.array_field).toMatchObject({ type: "array", items: { type: "string" } });
    expect(parsed.input.properties.object_field.type).toBe("object");
    expect(parsed.output.required).toEqual(["string_field", "array_field", "object_field"]);
    expect(parsed.output.properties.object_field.type).toBe("object");
  });

  it("does NOT make the workspace callable — the .template file is ignored by the skill loader", async () => {
    const dir = path.join(ROOT, "workspace");
    await scaffoldWorkspaceDir(dir);
    expect(await loadSkills(dir)).toEqual([]);
  });

  it("is idempotent — a second scaffold leaves an edited template untouched", async () => {
    const dir = path.join(ROOT, "workspace2");
    await scaffoldWorkspaceDir(dir);
    const template = path.join(dir, SKILLS_DIR, "example-skill.json.template");
    fs.writeFileSync(template, "edited-by-user", "utf-8");
    await scaffoldWorkspaceDir(dir);
    expect(fs.readFileSync(template, "utf-8")).toBe("edited-by-user");
  });
});

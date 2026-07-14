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
    // Structured inputs lead; free-text remains an optional fallback.
    expect(parsed.input.required).toBeUndefined();
    expect(parsed.input.properties.record_id.type).toBe("string");
    expect(parsed.input.properties.query.type).toBe("string");
    expect(parsed.output.required).toEqual(["summary", "count", "items"]);
    expect(parsed.output.properties.items.type).toBe("array");
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

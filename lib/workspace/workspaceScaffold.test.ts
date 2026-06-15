import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { scaffoldWorkspaceDir } from "./workspaceScaffold";
import { loadSkills } from "./skillStore";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-test-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("scaffoldWorkspaceDir", () => {
  it("seeds AGENTS.md and a skills/ dir with the example template", async () => {
    const dir = path.join(ROOT, "ws");
    await scaffoldWorkspaceDir(dir);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    const template = path.join(dir, "skills", "example-skill.json.template");
    expect(fs.existsSync(template)).toBe(true);
    // The template must itself be a valid skill definition once renamed to .json.
    const parsed = JSON.parse(fs.readFileSync(template, "utf-8"));
    expect(parsed.id).toBe("example-skill");
    expect(parsed.parameters.required).toEqual(["query"]);
  });

  it("does NOT make a fresh workspace callable — the .template file is ignored by the skill loader", async () => {
    const dir = path.join(ROOT, "ws2");
    await scaffoldWorkspaceDir(dir);
    expect(await loadSkills(dir)).toEqual([]);
  });
});

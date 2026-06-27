// scaffoldWorkspaceDir seeds only AGENTS.md. The skills/ dir + example .template are seeded
// later by scaffoldCalleeSkills, when the workspace first becomes a callee — so a caller-only
// workspace never gets them, and a fresh workspace has no callable skills.

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { scaffoldWorkspaceDir, scaffoldCalleeSkills } from "./workspaceScaffold";
import { loadSkills } from "./skillStore";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-test-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("scaffoldWorkspaceDir", () => {
  it("seeds AGENTS.md but NOT a skills/ dir", async () => {
    const dir = path.join(ROOT, "ws");
    await scaffoldWorkspaceDir(dir);
    expect(fs.existsSync(path.join(dir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "skills"))).toBe(false);
  });
});

describe("scaffoldCalleeSkills", () => {
  it("seeds the skills/ dir with the example template", async () => {
    const dir = path.join(ROOT, "callee");
    await scaffoldWorkspaceDir(dir);
    await scaffoldCalleeSkills(dir);
    const template = path.join(dir, "skills", "example-skill.json.template");
    expect(fs.existsSync(template)).toBe(true);
    // The template must itself be a valid skill definition once renamed to .json.
    const parsed = JSON.parse(fs.readFileSync(template, "utf-8"));
    expect(parsed.id).toBe("example-skill");
    // A minimal request/result contract: only `request` is required on input.
    expect(parsed.parameters.required).toEqual(["request"]);
    expect(parsed.output.required).toEqual(["result"]);
  });

  it("does NOT make the workspace callable — the .template file is ignored by the skill loader", async () => {
    const dir = path.join(ROOT, "callee2");
    await scaffoldWorkspaceDir(dir);
    await scaffoldCalleeSkills(dir);
    expect(await loadSkills(dir)).toEqual([]);
  });

  it("is idempotent — a second call leaves an edited template untouched", async () => {
    const dir = path.join(ROOT, "callee3");
    await scaffoldWorkspaceDir(dir);
    await scaffoldCalleeSkills(dir);
    const template = path.join(dir, "skills", "example-skill.json.template");
    fs.writeFileSync(template, "edited-by-user", "utf-8");
    await scaffoldCalleeSkills(dir);
    expect(fs.readFileSync(template, "utf-8")).toBe("edited-by-user");
  });
});

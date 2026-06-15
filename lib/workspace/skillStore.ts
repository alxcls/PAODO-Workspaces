// Reads skill definitions from a workspace's skills/ directory.
// The skill list is never a stored artifact — it is read from disk at call time
// by list_agents and executeSkill, so agent-written files (via file_write into the
// bind-mounted /workspace/skills/) are picked up with no extra plumbing.
import fsAsync from "fs/promises";
import path from "path";
import { createLogger } from "../infra/logger";
import type { SkillDefinition } from "./skillTypes";

const log = createLogger("skillStore");

export const SKILLS_DIR = "skills";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Minimal structural check — full schema correctness is ajv's job at call time.
// Skills missing required top-level fields are skipped with a warning rather than
// failing the whole listing, so one malformed file can't break a workspace.
function parseSkill(raw: unknown, file: string): SkillDefinition | null {
  if (!isRecord(raw)) return null;
  const { id, name, description, parameters, output } = raw;
  if (typeof id !== "string" || !id) {
    log.warn({ file }, "skill file missing string 'id' — skipped");
    return null;
  }
  if (!isRecord(parameters) || !isRecord(output)) {
    log.warn({ file, id }, "skill file missing 'parameters' or 'output' object — skipped");
    return null;
  }
  return {
    id,
    name: typeof name === "string" && name ? name : id,
    description: typeof description === "string" ? description : "",
    parameters,
    output,
  };
}

/** Reads and parses all skills/*.json in a workspace dir. Missing dir → empty list. */
export async function loadSkills(workspaceDir: string): Promise<SkillDefinition[]> {
  const dir = path.join(workspaceDir, SKILLS_DIR);
  let entries: string[];
  try {
    entries = await fsAsync.readdir(dir);
  } catch {
    return []; // no skills/ directory — workspace declares no skills
  }

  const skills: SkillDefinition[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const file = path.join(dir, entry);
    try {
      const raw = JSON.parse(await fsAsync.readFile(file, "utf-8")) as unknown;
      const skill = parseSkill(raw, file);
      if (skill) skills.push(skill);
    } catch (err) {
      log.warn({ err, file }, "failed to read or parse skill file — skipped");
    }
  }
  return skills;
}


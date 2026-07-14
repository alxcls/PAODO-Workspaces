// Owns the on-disk bootstrap of a workspace directory. Every workspace gets the user-editable
// AGENTS.md plus a .skills/ folder and example template. Call-specific skill execution guidance
// is injected only when this workspace is invoked as a callee.
// Kept separate from workspaceStore so registry/persistence concerns don't mix with
// filesystem scaffolding and the agent-instruction template.
import fsAsync from "fs/promises";
import fsSync from "fs";
import path from "path";
import { SKILLS_DIR } from "./skillStore";

const AGENTS_MD_TEMPLATE = `# Workspace Instructions

This is the master instructions file for the workspace agent.
Add your project-specific rules, conventions, and context here.
The agent will follow these instructions on every request.
`;

// Seeded into .skills/ at workspace creation so both the human and the agent have a
// working reference for the skill file format. The .template suffix keeps it out of
// the skill loader (which only reads *.json) — a fresh workspace declares no skills
// and is therefore not callable until a real skill file is written.
const SKILL_TEMPLATE = `${JSON.stringify(
  {
    id: "example-skill",
    description: "Example skill template. Replace this with a concise description of what the skill does for a caller.",
    input: {
      type: "object",
      properties: {
        record_id: { type: "string", description: "Optional stable identifier of the record to retrieve. Replace with the domain-specific identifier for this skill." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Optional maximum number of records to return. Keep only if this skill returns a collection." },
        query: { type: "string", description: "Optional free-text fallback when the caller's intent cannot be expressed with this skill's structured fields." },
      },
      examples: [{ record_id: "record-123" }, { limit: 20 }, { query: "Find records related to onboarding" }],
    },
    output: {
      type: "object",
      description: "Replace this example shape with the fields a caller needs. Prefer named fields and typed arrays/objects for data the caller will use; do not collapse a collection into one prose string.",
      properties: {
        summary: { type: "string", description: "A short human-readable summary of the result" },
        count: { type: "integer", description: "Number of matching records" },
        items: {
          type: "array",
          description: "Structured records for the caller. Replace id and label with the domain fields this skill returns.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable identifier for this record" },
              label: { type: "string", description: "Human-readable name for this record" },
            },
            required: ["id", "label"],
          },
        },
      },
      required: ["summary", "count", "items"],
      examples: [{ summary: "Found 2 matching records.", count: 2, items: [{ id: "record-1", label: "First record" }, { id: "record-2", label: "Second record" }] }],
    },
  },
  null,
  2
)}\n`;

export async function scaffoldWorkspaceDir(dir: string): Promise<void> {
  await fsAsync.mkdir(dir, { recursive: true });
  await fsAsync.writeFile(path.join(dir, "AGENTS.md"), AGENTS_MD_TEMPLATE, "utf8");
  const skillsDir = path.join(dir, SKILLS_DIR);
  if (fsSync.existsSync(skillsDir)) return;
  await fsAsync.mkdir(skillsDir, { recursive: true });
  await fsAsync.writeFile(path.join(skillsDir, "example-skill.json.template"), SKILL_TEMPLATE, "utf8");
}

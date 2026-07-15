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
        string_field: { type: "string", description: "Replace with a domain-specific string field." },
        number_field: { type: "number", minimum: 0, maximum: 1, description: "Replace with a domain-specific number and real bounds, or remove the bounds." },
        integer_field: { type: "integer", minimum: 1, maximum: 100, description: "Replace with a domain-specific integer and real bounds, or remove the bounds." },
        boolean_field: { type: "boolean", description: "Replace with a domain-specific boolean field." },
        enum_field: { type: "string", enum: ["option-a", "option-b"], description: "Replace with a domain-specific closed choice." },
        array_field: { type: "array", description: "Replace with a domain-specific collection.", items: { type: "string" } },
        object_field: { type: "object", description: "Replace with a domain-specific structured object.", properties: { string_field: { type: "string" } } },
      },
      required: ["string_field", "integer_field", "boolean_field"],
      examples: [{ string_field: "string", integer_field: 10, boolean_field: true }, { string_field: "string", number_field: 0.5, integer_field: 10, boolean_field: true, enum_field: "option-a", array_field: ["string"], object_field: { string_field: "string" } }],
    },
    output: {
      type: "object",
      description: "Replace every placeholder with the domain-specific fields a caller needs.",
      properties: {
        string_field: { type: "string", description: "Replace with a domain-specific string field." },
        number_field: { type: "number", description: "Replace with a domain-specific number field." },
        integer_field: { type: "integer", description: "Replace with a domain-specific integer field." },
        boolean_field: { type: "boolean", description: "Replace with a domain-specific boolean field." },
        array_field: { type: "array", description: "Replace with a domain-specific collection.", items: { type: "string" } },
        object_field: { type: "object", description: "Replace with a domain-specific structured object.", properties: { string_field: { type: "string" } } },
      },
      required: ["string_field", "array_field", "object_field"],
      examples: [{ string_field: "string", number_field: 0.5, integer_field: 10, boolean_field: true, array_field: ["string"], object_field: { string_field: "string" } }],
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

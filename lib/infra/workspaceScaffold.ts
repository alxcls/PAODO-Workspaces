// Owns the on-disk bootstrap of a new workspace directory: creating the folder and
// seeding the default AGENTS.md the agent later reads into its system prompt.
// Kept separate from workspaceStore so registry/persistence concerns don't mix with
// filesystem scaffolding and the agent-instruction template.
import fsAsync from "fs/promises";
import path from "path";

const AGENTS_MD_TEMPLATE = `# Workspace Instructions

This is the master instructions file for the workspace agent.
Add your project-specific rules, conventions, and context here.
The agent will follow these instructions on every request.

## Skills (agent-to-agent calls)

Other agents can only call this workspace through skills declared in the \`skills/\`
folder — one JSON file per skill, with typed input (\`parameters\`) and output
(\`output\`) schemas the platform enforces on every call. No skills means this
workspace is not callable. To declare one, copy \`skills/example-skill.json.template\`
to \`skills/<skill-id>.json\` and edit it (the \`.template\` file itself is ignored).
`;

// Seeded into skills/ at workspace creation so both the human and the agent have a
// working reference for the skill file format. The .template suffix keeps it out of
// the skill loader (which only reads *.json) — a fresh workspace declares no skills
// and is therefore not callable until a real skill file is written.
const SKILL_TEMPLATE = `${JSON.stringify(
  {
    id: "example-skill",
    name: "Example Skill",
    description:
      "Template — copy to <skill-id>.json and edit. 'parameters' is the JSON Schema for the args a caller must send; 'output' is the JSON Schema your final answer must match (every declared output field is required unless you add your own 'required' array).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the calling agent wants from this skill" },
        format: { type: "string", enum: ["short", "detailed"], description: "Optional response format" },
      },
      required: ["query"],
    },
    output: {
      type: "object",
      properties: {
        result: { type: "string", description: "The answer to the query" },
      },
    },
  },
  null,
  2
)}\n`;

export async function scaffoldWorkspaceDir(dir: string): Promise<void> {
  await fsAsync.mkdir(dir, { recursive: true });
  await fsAsync.writeFile(path.join(dir, "AGENTS.md"), AGENTS_MD_TEMPLATE, "utf8");
  // Skill definitions (one JSON file per skill) read by list_agents / executeSkill.
  await fsAsync.mkdir(path.join(dir, "skills"), { recursive: true });
  await fsAsync.writeFile(path.join(dir, "skills", "example-skill.json.template"), SKILL_TEMPLATE, "utf8");
}

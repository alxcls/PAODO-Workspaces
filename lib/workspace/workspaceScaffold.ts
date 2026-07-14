// Owns the on-disk bootstrap of a workspace directory. Two distinct moments:
//  - scaffoldWorkspaceDir: at creation, seeds only the user-editable AGENTS.md.
//  - scaffoldCalleeSkills: when the workspace first becomes a callee (an incoming graph
//    edge), seeds the skills/ folder + example template — caller-only workspaces never get it.
// The skill/drive *guidance* is no longer baked into AGENTS.md; it is injected into the
// system prompt dynamically (callee guidance + connected-drives block) by promptContext.
// Kept separate from workspaceStore so registry/persistence concerns don't mix with
// filesystem scaffolding and the agent-instruction template.
import fsAsync from "fs/promises";
import fsSync from "fs";
import path from "path";

const AGENTS_MD_TEMPLATE = `# Workspace Instructions

This is the master instructions file for the workspace agent.
Add your project-specific rules, conventions, and context here.
The agent will follow these instructions on every request.
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
      "Template — copy to <skill-id>.json and edit. 'id' is the machine key (must match ^[a-zA-Z0-9_-]{1,64}$; it also becomes the tool name if this workspace is exposed over MCP) and 'name' is the human-readable label. 'parameters' is the JSON Schema for the args a caller must send; 'output' is the JSON Schema your final answer must match (every declared output field is required unless you add your own 'output.required' array). Keep fields flat so callers see them clearly in list_agents.",
    parameters: {
      type: "object",
      properties: {
        request: { type: "string", description: "Plain-language description of what the calling agent wants from this skill" },
      },
      required: ["request"],
    },
    output: {
      type: "object",
      properties: {
        result: { type: "string", description: "A short answer or summary for the caller" },
      },
      required: ["result"],
    },
  },
  null,
  2
)}\n`;

export async function scaffoldWorkspaceDir(dir: string): Promise<void> {
  await fsAsync.mkdir(dir, { recursive: true });
  await fsAsync.writeFile(path.join(dir, "AGENTS.md"), AGENTS_MD_TEMPLATE, "utf8");
}

// Seeds the skills/ folder + example template the first time this workspace becomes a
// callee. Idempotent: if the folder already exists we leave it untouched, so a user's
// edited skills are never clobbered by a later re-connect.
export async function scaffoldCalleeSkills(dir: string): Promise<void> {
  const skillsDir = path.join(dir, "skills");
  if (fsSync.existsSync(skillsDir)) return;
  await fsAsync.mkdir(skillsDir, { recursive: true });
  await fsAsync.writeFile(path.join(skillsDir, "example-skill.json.template"), SKILL_TEMPLATE, "utf8");
}

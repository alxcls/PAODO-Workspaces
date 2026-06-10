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
`;

export async function scaffoldWorkspaceDir(dir: string): Promise<void> {
  await fsAsync.mkdir(dir, { recursive: true });
  await fsAsync.writeFile(path.join(dir, "AGENTS.md"), AGENTS_MD_TEMPLATE, "utf8");
}

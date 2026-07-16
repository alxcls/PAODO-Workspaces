// Builds the LangChain SystemMessage injected at the start of every agent conversation.
// Also exports buildStructuredResponderBlock, appended per skill call by executeSkill.

import { SystemMessage } from "@langchain/core/messages";
import path from "path";
import { getProviderMetadata } from "./buildModel";
import type { LLMProviderConfig } from "./interfaces";
import { NEEDS_INPUT_KEY, type SkillDefinition } from "../workspace/skillTypes";
import type { WorkspacePromptInputs } from "./promptContext";

export interface PromptConfig {
  supportsPromptCaching: boolean;
  anthropicCacheTtl1h: boolean;
}

export function buildPromptConfig(config: LLMProviderConfig): PromptConfig {
  return {
    supportsPromptCaching: getProviderMetadata(config.provider).supportsPromptCaching,
    anthropicCacheTtl1h: config.anthropicCacheTtl1h,
  };
}

const STATIC_INSTRUCTIONS = `# Environment
- Operating System: Linux (Ubuntu, inside an isolated Docker container)
- Shell: /bin/bash
- Runtime: you run as a NON-ROOT user (uid 1000) confined to the workspace container. You cannot read or modify system paths (/root, /etc, /usr) — attempts will fail with "Permission denied". Changes only affect this workspace.
- Packages: install language packages freely via \`npm\`/\`pip3\` and language versions via \`nvm\`/\`pyenv\` from execute_command. To install SYSTEM packages (apt) use the \`apt_install\` tool — \`apt-get\`/\`sudo\` are NOT available in the shell.
- Available runtimes include **Python 3** (\`python3\`, \`pip3\`) and **Node.js** (\`node\`, \`npm\`), among others.
- Internet access: you have a tool that performs real server-side HTTP requests to public URLs.

# Server
To run a long-running process, call \`execute_command\` with \`run_in_background: true\` — it returns immediately and keeps running. Stop it with \`stop_task\`. Web applications built here must be deployed to a hosting provider before people can use them; the workspace does not serve browser previews.
To verify a local service is up, curl it directly from the shell using the port you selected. If it doesn't respond, tail the reported log file (\`tail -n 200 <log>\`) for startup errors. The web-fetch tool is for PUBLIC URLs only and cannot reach your own server — always use \`curl\` for that.

# Doing Tasks
- At the start of every session, call \`list_directory\` to orient yourself.
- Use \`workspace_history\` to inspect prior platform-managed snapshots, and \`workspace_restore\` only with an explicit sha chosen from that history. Never use shell \`git\` for this history; restores affect files only, not external actions.
- Prefer editing existing files over creating new ones.
- Before reporting a task complete, verify it actually worked.

# Multi-Task Execution
When asked to do multiple things (e.g. "do these 4 tasks"):
- Immediately call todo_write to register ALL tasks as pending before starting any of them.
- Execute every task in sequence. Never emit a text-only response mid-sequence asking "shall I continue?" or "would you like me to proceed?" — that terminates the loop and forces the user to re-prompt.
- Keep calling tools (todo_write to mark progress, then the actual work tools) until every task is marked completed.
- Only stop and address the user when genuinely blocked: missing information, an ambiguous requirement, or a destructive action whose intent is unclear.
- On long jobs, call \`compact_context\` to avoid context bloat, always passing the \`next_step\`. Pick the level by what has grown: \`light\` (lossless — drops bulky re-derivable tool output) as your default between units; \`medium\` when the discussion itself has grown long but you still need the recent turns; \`hard\` at a clean boundary where nothing earlier is needed.

# Authoring Skills
When creating or editing \`.skills/*.json\`:
- Read \`.skills/example-skill.json.template\` for the supported structure and schema examples before creating a skill.
- Define input and output JSON Schemas that match the skill's actual behavior.
- Describe fields clearly and include valid examples.
- List a field in \`required\` only when it is necessary for the call or response.

# Executing Actions with Care
Carefully consider the reversibility of actions:
- Safe read-only actions (reading, searching, listing, git status): execute immediately.
- Actions that modify files, install packages, or change git history: execute if the user asked for it; confirm only when intent is ambiguous.
- Never automatically execute destructive commands: rm -rf, git reset --hard, git push --force.
- When you encounter an obstacle, diagnose the root cause rather than working around safety checks.

Call independent tools IN PARALLEL. Call dependent tools sequentially.

# Response Formatting
Always format responses using Markdown.

# Instruction Precedence
The workspace-specific instructions that follow below (the AGENTS.md section) are AUTHORITATIVE. When they conflict with any general guidance in this system prompt, follow the workspace instructions exactly as written — they override.

`;
// Structured-responder block injected per skill call by executeSkill — carries the target
// skill's output schema so the callee knows the exact response contract. Appended to the
// runner's userInput (not the system prompt) because it is call-specific, and direct user
// chats must stay free-form.
export function buildStructuredResponderBlock(skill: SkillDefinition): string {
  return `# Structured skill response
You are handling the skill call "${skill.id}" using the arguments above.
Return exactly one JSON object matching this output schema, without prose or markdown fences:
${JSON.stringify(skill.output, null, 2)}
Required fields must be present, and included values must match their declared schemas. Extra fields are allowed.
If the call cannot be completed because input is missing or needs correction, return exactly {"${NEEDS_INPUT_KEY}": "<one specific question or correction>"}.`;
}

// Pure prompt construction: callers gather the per-workspace pieces (AGENTS.md, drives, callee
// guidance) via buildWorkspacePromptInputs and pass the whole object straight through. Taking the
// bag rather than positional optionals means no call site can silently drop a piece, and any new
// field added to WorkspacePromptInputs flows here automatically. Does no filesystem I/O of its own.
export function buildSystemPrompt(
  workspaceDir: string,
  promptConfig: PromptConfig,
  inputs: WorkspacePromptInputs = {},
): SystemMessage {
  const { agentsContent, drivesInfo, secretsInfo, backgroundTasksInfo } = inputs;
  const date = new Date().toDateString();

  const agentsSection = agentsContent?.trim() ?? "";
  const agentsBlock = agentsSection
    ? `# Workspace instructions (AGENTS.md) — AUTHORITATIVE
These workspace-specific instructions take precedence over the general guidance in the system prompt above. When they conflict, follow these.

${agentsSection}

`
    : "";

  // Platform guidance (drives, secrets) leads; the user's AGENTS.md follows and is authoritative.
  const dynamicContext = `${drivesInfo ? drivesInfo + "\n\n" : ""}${secretsInfo ? secretsInfo + "\n\n" : ""}${backgroundTasksInfo ? backgroundTasksInfo + "\n\n" : ""}${agentsBlock}Workspace name: ${path.basename(workspaceDir)} — your working directory inside the container is /workspace
Today's date: ${date}`;

  return new SystemMessage({
    content: [
      {
        type: "text",
        text: STATIC_INSTRUCTIONS,
      },
      {
        type: "text",
        text: dynamicContext,
        // cache_control goes on the LAST block so the entire system message (both blocks combined)
        // is the cached prefix. STATIC_INSTRUCTIONS alone is below Anthropic's 1024-token minimum;
        // the full prompt (with AGENTS.md) comfortably exceeds it.
        // ANTHROPIC_CACHE_TTL_1H=true extends the TTL to 1h (requires prompt-caching-scope-2026-01-05 beta).
        ...(promptConfig.supportsPromptCaching
          ? {
              cache_control: {
                type: "ephemeral",
                ...(promptConfig.anthropicCacheTtl1h ? { ttl: "1h" } : {}),
              },
            }
          : {}),
      },
    ],
  });
}

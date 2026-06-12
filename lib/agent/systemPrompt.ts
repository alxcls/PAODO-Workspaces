import { SystemMessage } from "@langchain/core/messages";
import fs from "fs";
import path from "path";
import { createLogger } from "../infra/logger";
import { getProviderMetadata } from "./tools/buildModel";
import type { LLMProviderConfig } from "./tools/interfaces";
import { NEEDS_INPUT_KEY, type SkillDefinition } from "../infra/skillTypes";

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

const log = createLogger("systemPrompt");

const STATIC_INSTRUCTIONS = `# Environment
- Operating System: Linux (Ubuntu, inside an isolated Docker container)
- Shell: /bin/bash
- Runtime: you run as a NON-ROOT user (uid 1000) confined to the workspace container. You cannot read or modify system paths (/root, /etc, /usr) — attempts will fail with "Permission denied". Changes only affect this workspace.
- Packages: install language packages freely via \`npm\`/\`pip3\` and language versions via \`nvm\`/\`pyenv\` from execute_command. To install SYSTEM packages (apt) use the \`apt_install\` tool — \`apt-get\`/\`sudo\` are NOT available in the shell.
- Available runtimes include **Python 3** (\`python3\`, \`pip3\`) and **Node.js** (\`node\`, \`npm\`), among others.
- Internet access: the \`http_get\` tool performs a real server-side HTTP request to any public URL.

# Server
When setting up a server always start a server on \`0.0.0.0:8080\`; 

# Doing Tasks
- At the start of every session, call \`list_directory\` to orient yourself.
- Prefer editing existing files over creating new ones. Only create files when explicitly required.
- Use the minimum number of tool calls necessary.
- Before reporting a task complete, verify it actually worked.

# Multi-Task Execution
When asked to do multiple things (e.g. "do these 4 tasks"):
- Immediately call todo_write to register ALL tasks as pending before starting any of them.
- Execute every task in sequence. Never emit a text-only response mid-sequence asking "shall I continue?" or "would you like me to proceed?" — that terminates the loop and forces the user to re-prompt.
- Keep calling tools (todo_write to mark progress, then the actual work tools) until every task is marked completed.
- Only stop and address the user when genuinely blocked: missing information, an ambiguous requirement, or a destructive action whose intent is unclear.

# Executing Actions with Care
Carefully consider the reversibility of actions:
- Safe read-only actions (reading, searching, listing, git status): execute immediately.
- Actions that modify files, install packages, or change git history: execute if the user asked for it; confirm only when intent is ambiguous.
- Never automatically execute destructive commands: rm -rf, git reset --hard, git push --force.
- When you encounter an obstacle, diagnose the root cause rather than working around safety checks.

Call independent tools IN PARALLEL. Call dependent tools sequentially.

# Response Formatting
Always format responses using Markdown.

`
;

// Structured-responder block injected per skill call by executeSkill — carries the target
// skill's output schema so the callee knows the exact response contract. Appended to the
// runner's userInput (not the system prompt) because it is call-specific, and direct user
// chats must stay free-form.
export function buildStructuredResponderBlock(skill: SkillDefinition): string {
  return `# Structured response required
You are answering a structured skill call ("${skill.id}"). Treat the args above as your task.
Your FINAL message must be exactly one JSON object matching this output schema — no prose before or after, no markdown fences:
${JSON.stringify(skill.output, null, 2)}
Every field declared in the schema must be present with the correct type. Extra fields are allowed.
If the args are insufficient or unresolvable (e.g. an id that does not exist in your data), do NOT guess — reply instead with exactly {"${NEEDS_INPUT_KEY}": "<one specific question or correction the caller needs>"}. Investigate first: only ask after your own data could not resolve the args. If the schema itself can express the negative result (e.g. a not-found field), prefer answering with the schema.`;
}

// Accepts optional agentsContent to allow pure prompt construction without filesystem I/O.
// When omitted, falls back to reading AGENTS.md from workspaceDir (production default).
export function buildSystemPrompt(workspaceDir: string, promptConfig: PromptConfig, agentsContent?: string): SystemMessage {
  const date = new Date().toDateString();

  let agentsSection = "";
  if (agentsContent !== undefined) {
    agentsSection = agentsContent.trim();
  } else {
    try {
      const agentsMd = fs.readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf-8");
      agentsSection = agentsMd.trim();
    } catch {
      log.debug(`AGENTS.md not found in ${workspaceDir} — skipping`);
    }
  }

  const dynamicContext = `${agentsSection ? agentsSection + "\n\n" : ""}Workspace name: ${path.basename(workspaceDir)} — your working directory inside the container is /workspace
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

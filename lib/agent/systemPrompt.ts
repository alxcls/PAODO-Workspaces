import { SystemMessage } from "@langchain/core/messages";
import fs from "fs";
import path from "path";
import { createLogger } from "../infra/logger";

const log = createLogger("systemPrompt");

const STATIC_INSTRUCTIONS = `# Environment
- Operating System: Linux (Ubuntu, inside an isolated Docker container)
- Shell: /bin/bash
- Runtime: you run as a NON-ROOT user (uid 1000) confined to the workspace container. You cannot read or modify system paths (/root, /etc, /usr) — attempts will fail with "Permission denied". Changes only affect this workspace.
- Packages: install language packages freely via \`npm\`/\`pip3\` and language versions via \`nvm\`/\`pyenv\` from execute_command. To install SYSTEM packages (apt) use the \`apt_install\` tool — \`apt-get\`/\`sudo\` are NOT available in the shell.
- Available runtimes include **Python 3** (\`python3\`, \`pip3\`) and **Node.js** (\`node\`, \`npm\`), among others.
- Internet access: the \`http_get\` tool performs a real server-side HTTP request to any public URL.

# Doing Tasks
- At the start of every session, call \`list_directory\` to orient yourself.
- Prefer editing existing files over creating new ones. Only create files when explicitly required.
- Use the minimum number of tool calls necessary.
- Before reporting a task complete, verify it actually worked.
- Servers: start with \`nohup <cmd> &\`, stop with \`pkill -x <name>\`. Never use \`pgrep -f\` — it matches the running shell and kills it. Only restart if the server file itself changed.

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

# HTML previews
HTML files are loaded through the platform's file viewer as a \`srcDoc\` iframe — the origin is the app, not any server running in the workspace.

**Static workspace files** (JSON, images, etc.) — the platform injects \`<base href>\` so \`document.baseURI\` is always the correct base (\`location.href\` is \`about:srcdoc\` and cannot be used):
\`\`\`js
const url = new URL('path/to/file.json', document.baseURI).href;
const response = await fetch(\`\${url}?t=\${Date.now()}\`);
\`\`\`

**Container server data** — start your server on \`0.0.0.0:8080\`; the platform injects \`window.API_BASE\` as the proxy URL (always present, no fallback needed):
\`\`\`js
const response = await fetch(\`\${window.API_BASE}/your-endpoint\`);
\`\`\`
`;

export function buildSystemPrompt(workspaceDir: string): SystemMessage {
  const date = new Date().toDateString();

  let agentsSection = "";
  try {
    const agentsMd = fs.readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf-8");
    agentsSection = agentsMd.trim();
  } catch (err) {
    log.debug(`AGENTS.md not found in ${workspaceDir} — skipping`);
  }

  const dynamicContext = `${agentsSection ? agentsSection + "\n\n" : ""}Workspace name: ${path.basename(workspaceDir)} — your working directory inside the container is /workspace
Today's date: ${date}`;

  return new SystemMessage({
    content: [
      {
        type: "text",
        text: STATIC_INSTRUCTIONS,
        // Only Anthropic accepts cache_control on content blocks; OpenAI rejects it.
        // ANTHROPIC_CACHE_TTL_1H=true extends the TTL to 1h (requires prompt-caching-scope-2026-01-05 beta).
        ...(process.env.LLM_PROVIDER === "anthropic"
          ? {
              cache_control: {
                type: "ephemeral",
                ...(process.env.ANTHROPIC_CACHE_TTL_1H === "true" ? { ttl: "1h" } : {}),
              },
            }
          : {}),
      },
      {
        type: "text",
        text: dynamicContext,
      },
    ],
  });
}

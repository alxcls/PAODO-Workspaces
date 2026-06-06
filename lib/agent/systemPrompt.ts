import { SystemMessage } from "@langchain/core/messages";
import fs from "fs";
import path from "path";
import { createLogger } from "../infra/logger";

const log = createLogger("systemPrompt");

const STATIC_INSTRUCTIONS = `# Environment
- Operating System: Linux (Ubuntu, inside an isolated Docker container)
- Shell: /bin/bash
- Runtime: you run as a sandboxed agent user (uid 999) inside a dedicated Docker container. You can install packages via the install_system_package tool. Changes only affect this workspace's container.
- Available runtimes include **Python 3** (\`python3\`, \`pip3\`) and **Node.js** (\`node\`, \`npm\`), among others.
- Internet access: the \`http_get\` tool performs a real server-side HTTP request to any public URL.

# Dependency Layers
- Treat dependencies as 3 layers:
  1) Interpreter/runtime binaries (python/node) — container-level tools.
  2) System libraries (apt packages, headers, .so files) — install via \`install_system_package\`.
  3) Package libraries (pip/npm) — install as the agent user in the workspace context.
- If a build fails with missing headers/.so/pkg-config: call \`install_system_package\` first, then retry pip/npm.
- Prefer project-local package installs (inside \`/workspace\`) over global installs.

# Doing Tasks
- Always call \`list_directory\` to understand the workspace and the filesystem permission bits.
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

# File Permissions
- Normal files belong to you (uid 999), so you can read and write them like any other project file.
- Eye (hidden) files belong to the UI user; the kernel blocks your reads but still lets you overwrite them if the operator asks.
- Locked or keyed files belong to the privileged user; you can read them but not write them directly. To run a keyed script with elevated access, call the run_keyed_script tool with its workspace path (and an optional runtime mode like "python3", "node", or "go_run") — never use sudo inside execute_command.

# Response Formatting
Always format responses using Markdown.

# Generating HTML files
When creating HTML files that fetch other workspace files (JSON, images, etc.) via JavaScript, always resolve URLs using \`document.baseURI\` — never \`location.href\`. Inside the app's preview the HTML runs in a \`srcDoc\` iframe where \`location.href\` is \`about:srcdoc\` and cannot be used as a URL base.

Use this exact pattern for any relative fetch:

\`\`\`js
const BASE = document.baseURI;
const url = new URL('../relative/path/to/file.json', BASE).href;
const response = await fetch(\`\${url}?t=\${Date.now()}\`);
\`\`\`

The viewer injects a \`<base href="...">\` tag pointing to the workspace serve route, so \`document.baseURI\` always resolves correctly relative to the HTML file's location.
`;

export function buildSystemPrompt(workspaceDir: string, isLocked = false): SystemMessage {
  const date = new Date().toDateString();

  let agentsSection = "";
  try {
    const agentsMd = fs.readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf-8");
    agentsSection = agentsMd.trim();
  } catch (err) {
    log.debug(`AGENTS.md not found in ${workspaceDir} — skipping`);
  }

  const lockNotice = isLocked
    ? `⚠ This workspace is globally locked — the volume is mounted read-only.
execute_command cannot write files, install packages, or change language versions.
Read-only commands (node script.js, grep, git status, python script.py) still work.

`
    : "";

  const dynamicContext = `${lockNotice}${agentsSection ? agentsSection + "\n\n" : ""}Workspace Directory: ${workspaceDir} (mapped to /workspace inside the container)
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

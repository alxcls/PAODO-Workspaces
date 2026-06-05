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
- Normal files are owned by you (\`agent:access\`) so you can read and write them.
- Eye-off paths switch to \`appuser:access\` with other bits cleared, so you can still write (kernel blocks reads).
- Locked or keyed paths are owned by \`privd:access\` with other bits read-only (or none) — you can read but not modify them unless a script is `[keyed]` and you run it via \`sudo /workspace/<path>\`.

**[keyed]** means the operator has granted that script elevated execution via sudo. Run it with the absolute /workspace/ path:

    execute_command("sudo /workspace/scripts/update_data.py")

sudo runs the script as **uid 998 (privd)**, which owns locked files and can write them. The script must have a shebang line (e.g. #!/usr/bin/env python3) — the OS uses it to pick the interpreter. Always use the absolute /workspace/<relpath> path; relative paths do not resolve correctly under sudo.

When you are blocked, tell the user which mode bits are preventing the action and what they need to change in the file tree (eye icon to un-hide, lock icon to unlock, key icon to elevate a script).

Call independent tools IN PARALLEL. Call dependent tools sequentially.

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

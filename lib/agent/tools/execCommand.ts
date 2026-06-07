// Agent tool that spawns a bash command in the workspace directory.
// Streams stdout and stderr live to connected WebSocket clients so they appear in the console panel,
// and returns the combined output to the agent as the tool result.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn } from "child_process";
import { broadcastToWorkspace } from "../../infra/wsHub";
import { ensureContainer } from "../../infra/containerManager";
import { createLogger } from "../../infra/logger";

// Kill if no output for this long (catches hung processes without interrupting active ones).
const SILENCE_TIMEOUT_MS = parseInt(process.env.EXEC_SILENCE_TIMEOUT_MS ?? "", 10) || 60_000;
// Absolute ceiling regardless of output activity.
const MAX_TIMEOUT_MS = parseInt(process.env.EXEC_MAX_TIMEOUT_MS ?? "", 10) || 30 * 60_000;

export function buildExecCommandTool(workspaceId: string, workspaceDir: string) {
  const log = createLogger("execCommand");
  return tool(
    async ({ command }) => {
      await ensureContainer(workspaceId, workspaceDir);

      return new Promise<string>((resolve) => {
        const proc = spawn("docker", ["exec", "-i", "-w", "/workspace", `ws_${workspaceId}`, "/bin/bash", "-c", command]);

        // Close stdin immediately so commands that read from stdin when no path
        // is given (e.g. `rg pattern` without a path) don't hang waiting for input.
        proc.stdin.end();

        let stdout = "";
        let stderr = "";
        const startedAt = Date.now();
        let lastOutputAt = Date.now();
        let killed = false;

        const killWith = (reason: string) => {
          if (killed) return;
          killed = true;
          proc.kill("SIGTERM");
          log.warn({ workspaceId, command, reason }, "command killed");
          broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stdout", workspaceId, data: `\n[timeout] ${reason}\n` }));
        };

        const heartbeat = setInterval(() => {
          const now = Date.now();
          const silentMs = now - lastOutputAt;
          const elapsedMs = now - startedAt;
          const elapsed = Math.round(elapsedMs / 1000);

          if (elapsedMs >= MAX_TIMEOUT_MS) {
            killWith(`Command killed after ${elapsed}s (max runtime exceeded).`);
            return;
          }
          if (silentMs >= SILENCE_TIMEOUT_MS) {
            killWith(`Command killed after ${Math.round(silentMs / 1000)}s with no output.`);
            return;
          }
          if (silentMs >= 5_000) {
            broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stdout", workspaceId, data: `⏳ still running... (${elapsed}s elapsed)\n` }));
          }
        }, 5_000);

        proc.stdout.on("data", (chunk: Buffer) => {
          lastOutputAt = Date.now();
          const text = chunk.toString();
          stdout += text;
          broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stdout", workspaceId, data: text }));
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          lastOutputAt = Date.now();
          const text = chunk.toString();
          stderr += text;
          broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stderr", workspaceId, data: text }));
        });

        proc.on("close", (code) => {
          clearInterval(heartbeat);
          broadcastToWorkspace(workspaceId, JSON.stringify({ type: "exec_done", workspaceId, exitCode: code }));
          let stderrOut = stderr.trim() ? `[stderr]: ${stderr.trim()}` : "";
          if (stderrOut.includes("no matching entries in passwd file")) {
            stderrOut += "\n[setup] The workspace container is stale. The user needs to run: docker rmi paodo-workspace && docker rm ws_" + workspaceId + " — the server will rebuild automatically on the next command.";
          } else if (stderrOut.includes("Permission denied")) {
            stderrOut += "\n[permission] You run as a non-root user and cannot modify system paths (e.g. /etc, /root, /usr). For workspace files, check ownership; to install system packages use the apt_install tool instead of apt-get.";
          }
          const parts = [stdout.trim(), stderrOut].filter(Boolean);
          resolve(parts.join("\n") || "Command executed successfully with no output.");
        });

        proc.on("error", (err) => {
          clearInterval(heartbeat);
          resolve(`Command execution failed:\n${err.message}`);
        });
      });
    },
    {
      name: "execute_command",
      description: `Execute a bash shell command in the workspace directory.

Covers all shell operations including:
- File search:        find . -name "*.ts" (or fd)
- Content search:     grep -rn "pattern" --include="*.ts" (exclude node_modules/.git/.next automatically)
- File deletion:      rm filename
- Git operations:     git status, git log --oneline, git diff
- Running scripts:    node script.js, npm run build, python3 script.py
- Package management: npm install, pnpm install, pip3 install <package>
- JSON extraction:    jq '.key' file.json
- Piping/chaining:    cmd1 | cmd2, cmd1 && cmd2

Do NOT use for: reading file contents (use file_read), editing file contents (use file_edit), writing new file contents (use file_write).
USE THIS for: renaming files (mv), moving files, deleting files (rm), creating symlinks, and any other shell file-system operation that doesn't involve reading or writing file content.
Always use POSIX/bash syntax. Never use PowerShell syntax.
You run as a NON-ROOT user, confined to the workspace. apt-get/sudo are NOT available here — to install system packages use the apt_install tool. npm/pip/nvm/pyenv work normally.`,
      schema: z.object({
        command: z.string().describe("The bash command to execute"),
      }),
    }
  );
}

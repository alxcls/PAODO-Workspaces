// Agent tool that spawns a bash command in the workspace directory.
// Streams stdout and stderr live to connected WebSocket clients so they appear in the console panel,
// and returns the combined output to the agent as the tool result.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn } from "child_process";
import { broadcastToWorkspace } from "../../infra/wsHub";
import { ensureContainer } from "../../infra/containerManager";
import { getGlobalLock } from "../../infra/permissionStore";
import { createLogger } from "../../infra/logger";

const RESTRICTED_USER = "agent";

export function buildExecCommandTool(workspaceId: string, workspaceDir: string) {
  const log = createLogger("execCommand");
  return tool(
    async ({ command }) => {
      if (/\bchmod\b|\bchown\b|\bsudo\b|\bsu\b/.test(command)) {
        log.warn({ workspaceId, command }, "blocked command");
        return "Error: chmod, chown, sudo and su are not permitted. File permissions are managed by the user via the file tree UI.";
      }
      const [, isLocked] = await Promise.all([
        ensureContainer(workspaceId, workspaceDir),
        getGlobalLock(workspaceId),
      ]);
      const userArgs = isLocked ? ["-u", RESTRICTED_USER] : [];
      const TIMEOUT_MS = 120_000;

      return new Promise<string>((resolve) => {
        const proc = spawn("docker", ["exec", "-i", ...userArgs, "-w", "/workspace", `ws_${workspaceId}`, "/bin/bash", "-c", command]);

        // Close stdin immediately so commands that read from stdin when no path
        // is given (e.g. `rg pattern` without a path) don't hang waiting for input.
        proc.stdin.end();

        let stdout = "";
        let stderr = "";
        const startedAt = Date.now();
        let lastOutputAt = Date.now();

        const heartbeat = setInterval(() => {
          const silentMs = Date.now() - lastOutputAt;
          if (silentMs >= 5_000) {
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stdout", workspaceId, data: `⏳ still running... (${elapsed}s elapsed)\n` }));
          }
        }, 5_000);

        const hardTimeout = setTimeout(() => {
          proc.kill("SIGTERM");
          log.warn({ workspaceId, command, timeoutMs: TIMEOUT_MS }, "command timed out");
          broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stdout", workspaceId, data: `\n[timeout] Command killed after ${TIMEOUT_MS / 1000}s — no output received.\n` }));
        }, TIMEOUT_MS);

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
          clearTimeout(hardTimeout);
          broadcastToWorkspace(workspaceId, JSON.stringify({ type: "exec_done", workspaceId, exitCode: code }));
          let stderrOut = stderr.trim() ? `[stderr]: ${stderr.trim()}` : "";
          if (stderrOut.includes("no matching entries in passwd file")) {
            stderrOut += "\n[setup] The workspace container was built before UID enforcement was added. The user needs to run: docker rmi paodo-workspace && docker rm ws_" + workspaceId + " — the server will rebuild automatically on the next command.";
          } else if (stderrOut.includes("Permission denied")) {
            stderrOut += isLocked
              ? "\n[permission] The workspace is globally locked [R] — commands run as a restricted user that cannot write files or install packages. Ask the user to unlock the workspace first."
              : "\n[permission] One or more files involved are read-only [R]. Use list_directory or glob to check permissions before retrying.";
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
When the workspace is globally locked [R], write operations (npm install, file writes, apt-get, nvm install) are blocked — only read-only commands work.`,
      schema: z.object({
        command: z.string().describe("The bash command to execute"),
      }),
    }
  );
}

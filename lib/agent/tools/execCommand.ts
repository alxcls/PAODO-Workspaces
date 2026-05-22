// Agent tool that spawns a bash command in the workspace directory.
// Streams stdout and stderr live to connected WebSocket clients so they appear in the console panel,
// and returns the combined output to the agent as the tool result.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn } from "child_process";
import { broadcastToWorkspace } from "../../infra/wsHub";
import { ensureContainer } from "../../infra/containerManager";

export function buildExecCommandTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ command }) => {
      if (/\bchmod\b|\bchown\b|\bsudo\b|\bsu\b/.test(command)) {
        return "Error: chmod, chown, sudo and su are not permitted. File permissions are managed by the user via the file tree UI.";
      }
      await ensureContainer(workspaceId, workspaceDir);
      return new Promise<string>((resolve) => {
        const proc = spawn("docker", ["exec", "-i", "-w", "/workspace", `ws_${workspaceId}`, "/bin/bash", "-c", command]);

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stdout += text;
          broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stdout", workspaceId, data: text }));
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stderr += text;
          broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stderr", workspaceId, data: text }));
        });

        proc.on("close", (code) => {
          broadcastToWorkspace(workspaceId, JSON.stringify({ type: "exec_done", workspaceId, exitCode: code }));
          let stderrOut = stderr.trim() ? `[stderr]: ${stderr.trim()}` : "";
          if (stderrOut.includes("Permission denied")) {
            stderrOut += "\n[permission] One or more files involved are read-only [R]. Use list_directory or glob to check permissions before retrying.";
          }
          const parts = [stdout.trim(), stderrOut].filter(Boolean);
          resolve(parts.join("\n") || "Command executed successfully with no output.");
        });

        proc.on("error", (err) => {
          resolve(`Command execution failed:\n${err.message}`);
        });
      });
    },
    {
      name: "execute_command",
      description: `Execute a bash shell command in the workspace directory.

Covers all shell operations including:
- File search:        find . -name "*.ts" (or fd, ls)
- Content search:     grep -rn "pattern" --include="*.ts" (exclude node_modules/.git/.next automatically)
- File deletion:      rm filename
- Git operations:     git status, git log --oneline, git diff
- Running scripts:    node script.js, npm run build
- Package management: npm install, pnpm install
- JSON extraction:    jq '.key' file.json
- Piping/chaining:    cmd1 | cmd2, cmd1 && cmd2

Do NOT use for: reading files (use file_read), editing files (use file_edit), writing files (use file_write).
Always use POSIX/bash syntax. Never use PowerShell syntax.`,
      schema: z.object({
        command: z.string().describe("The bash command to execute"),
      }),
    }
  );
}

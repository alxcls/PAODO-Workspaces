// Agent tool that spawns a bash command in the workspace directory.
// Streams stdout and stderr live to connected WebSocket clients so they appear in the console panel,
// and returns the combined output to the agent as the tool result.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn } from "child_process";
import { broadcastToWorkspace } from "../../infra/wsHub";
import { ensureContainer } from "../../infra/containerManager";
import { getGlobalLock, readPermissionSnapshot, isKeyedFromSnapshot } from "../../infra/permissionStore";
import { createLogger } from "../../infra/logger";

const RESTRICTED_USER = "agent";
// Kill if no output for this long (catches hung processes without interrupting active ones).
const SILENCE_TIMEOUT_MS = parseInt(process.env.EXEC_SILENCE_TIMEOUT_MS ?? "", 10) || 60_000;
// Absolute ceiling regardless of output activity.
const MAX_TIMEOUT_MS = parseInt(process.env.EXEC_MAX_TIMEOUT_MS ?? "", 10) || 30 * 60_000;
const PRIVILEGED_HINT = "Need elevated changes while locked? Ask the operator to mark a script [keyed] in the file tree and rerun it as sudo /workspace/<script>.";
const WORKSPACE_PATH_RE = /\/workspace(?:\/|\b)/;
const RUNTIME_PATH_RE = /\/(usr\/local\/bin|usr\/bin|usr\/sbin|opt|home\/[^\s/:]+\/(\.nvm|\.pyenv))/;
const DEFAULT_PATH = "/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin";

export function buildExecCommandTool(workspaceId: string, workspaceDir: string) {
  const log = createLogger("execCommand");
  return tool(
    async ({ command }) => {
      // Intercept sudo — keyed scripts are dispatched as privd (uid 998) via server-side docker exec.
      // sudo is non-functional inside the container (no-new-privileges flag).
      // Match sudo anywhere in the command (e.g. "cd /workspace && sudo /workspace/script.py").
      let execUser = RESTRICTED_USER;
      let effectiveCommand = command.trimStart();

      const sudoMatch = effectiveCommand.match(/sudo\s+(?:-\S+\s+)*(\/workspace\/\S+)/);
      if (sudoMatch) {
        const relPath = sudoMatch[1].slice("/workspace/".length);
        const snapshot = await readPermissionSnapshot(workspaceId);
        if (!isKeyedFromSnapshot(snapshot, relPath)) {
          return `sudo denied: "${relPath}" is not marked [keyed]. Toggle the key icon in the file tree to enable privileged execution.`;
        }
        execUser = "privd";
        // Strip all sudo tokens so the command runs cleanly as privd.
        effectiveCommand = effectiveCommand.replace(/sudo\s+/g, "");
      } else if (/\bsudo\b/.test(effectiveCommand)) {
        return "sudo denied: only keyed scripts at an absolute /workspace/ path are supported.";
      }

      const [, isLocked] = await Promise.all([
        ensureContainer(workspaceId, workspaceDir),
        getGlobalLock(workspaceId),
      ]);
      const userArgs = ["-u", execUser];
      const envArgs = execUser === RESTRICTED_USER
        ? ["-e", "HOME=/home/agent"]
        : [];
      const commandToRun = execUser === RESTRICTED_USER
        ? `export PATH=${DEFAULT_PATH}:$PATH; ${effectiveCommand}`
        : effectiveCommand;

      return new Promise<string>((resolve) => {
        const proc = spawn("docker", ["exec", "-i", ...userArgs, ...envArgs, "-w", "/workspace", `ws_${workspaceId}`, "/bin/bash", "-c", commandToRun]);

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
            stderrOut += "\n[setup] The workspace container was built before UID enforcement was added. The user needs to run: docker rmi paodo-workspace && docker rm ws_" + workspaceId + " — the server will rebuild automatically on the next command.";
          } else if (stderrOut.includes("Permission denied")) {
            const touchesWorkspacePath = WORKSPACE_PATH_RE.test(stderrOut);
            const touchesRuntimePath = RUNTIME_PATH_RE.test(stderrOut);
            if (!touchesWorkspacePath && touchesRuntimePath) {
              stderrOut += "\n[runtime] A system/runtime executable exists but is not accessible to the agent identity. This is not a workspace [locked]/[eye-off] permission. Rebuild/fix the workspace image so runtimes are exposed from neutral executable paths (for example /usr/local/bin -> /opt/*), not private home directories.";
            } else {
              const permissionMsg = isLocked
                ? "\n[permission] The workspace is globally locked — commands run as agent (uid 999) which cannot write files or install packages. Ask the user to unlock the workspace first."
                : "\n[permission] A file or directory is locked [locked] or hidden [eye-off]. Check permissions with list_directory. Unlock it in the file tree before writing.";
              stderrOut += `${permissionMsg}\n[privileged] ${PRIVILEGED_HINT}`;
            }
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
When the workspace is globally locked (volume mounted read-only), write operations (npm install, file writes, apt-get, nvm install) are blocked — only read-only commands work.
When a path is locked (owned by privd, other=r--), shell writes to it are also blocked by the kernel. Run list_directory to read mode bits before operating on unfamiliar paths.`,
      schema: z.object({
        command: z.string().describe("The bash command to execute"),
      }),
    }
  );
}

// Agent tool that spawns a bash command in the workspace directory.
// Streams stdout and stderr live to connected WebSocket clients so they appear in the console panel,
// and returns the combined output to the agent as the tool result.
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { createLogger } from "../../infra/logger";
import type { StreamingExecFn, ExecConfig } from "./interfaces";

const schema = z.object({
  command: z.string().describe("The bash command to execute"),
});

// Maps known stderr signatures to actionable user guidance appended to the tool result.
// Returns "" when stderr is empty so callers can filter it out cleanly.
function diagnoseStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  let out = `[stderr]: ${trimmed}`;
  if (trimmed.includes("no matching entries in passwd file")) {
    out += "\n[setup] The workspace container is stale. The user needs to run: docker rmi paodo-workspace && docker rm ws_<id> — the server will rebuild automatically on the next command.";
  } else if (trimmed.includes("Permission denied")) {
    out += "\n[permission] You run as a non-root user and cannot modify system paths (e.g. /etc, /root, /usr). For workspace files, check ownership; to install system packages use the apt_install tool instead of apt-get.";
  }
  return out;
}

export class ExecCommandTool extends StructuredTool<typeof schema> {
  name = "execute_command";
  description = `Execute a bash shell command in the workspace directory.

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
You run as a NON-ROOT user, confined to the workspace. apt-get/sudo are NOT available here — to install system packages use the apt_install tool. npm/pip/nvm/pyenv work normally.`;
  schema = schema;

  private readonly log = createLogger("execCommand");

  constructor(
    private readonly streamExec: StreamingExecFn,
    private readonly broadcast: (msg: string) => void,
    private readonly execConfig: ExecConfig,
  ) {
    super();
  }

  protected async _call({ command }: z.infer<typeof schema>): Promise<string> {
    return new Promise<string>((resolve) => {
      let stdout = "";
      let stderr = "";
      const startedAt = Date.now();
      let lastOutputAt = Date.now();
      let killed = false;
      let killFn: (() => void) | null = null;

      const killWith = (reason: string) => {
        if (killed) return;
        killed = true;
        killFn?.();
        this.log.warn({ command, reason }, "command killed");
        this.broadcast(JSON.stringify({ type: "stdout", data: `\n[timeout] ${reason}\n` }));
      };

      const heartbeat = setInterval(() => {
        const now = Date.now();
        const silentMs = now - lastOutputAt;
        const elapsedMs = now - startedAt;
        const elapsed = Math.round(elapsedMs / 1000);

        if (elapsedMs >= this.execConfig.maxTimeoutMs) {
          killWith(`Command killed after ${elapsed}s (max runtime exceeded).`);
          return;
        }
        if (silentMs >= this.execConfig.silenceTimeoutMs) {
          killWith(`Command killed after ${Math.round(silentMs / 1000)}s with no output.`);
          return;
        }
        if (silentMs >= 5_000) {
          this.broadcast(JSON.stringify({ type: "stdout", data: `⏳ still running... (${elapsed}s elapsed)\n` }));
        }
      }, 5_000);

      // streamExec handles ensureContainer + docker exec; we only handle output routing and timeouts.
      const execPromise = this.streamExec(["/bin/bash", "-c", command], {
        onStdout: (text) => {
          if (killed) return;
          lastOutputAt = Date.now();
          stdout += text;
          this.broadcast(JSON.stringify({ type: "stdout", data: text }));
        },
        onStderr: (text) => {
          if (killed) return;
          lastOutputAt = Date.now();
          stderr += text;
          this.broadcast(JSON.stringify({ type: "stderr", data: text }));
        },
      });

      // Expose a kill path: when timeout fires we resolve the outer promise early.
      // The underlying process still runs to natural close but its output is discarded (killed=true).
      killFn = () => {
        clearInterval(heartbeat);
        resolve(`[timeout] Command killed.`);
      };

      execPromise.then(({ code }) => {
        if (killed) return;
        clearInterval(heartbeat);
        this.broadcast(JSON.stringify({ type: "exec_done", exitCode: code }));
        const stderrOut = diagnoseStderr(stderr);
        const parts = [stdout.trim(), stderrOut].filter(Boolean);
        resolve(parts.join("\n") || "Command executed successfully with no output.");
      }).catch((err) => {
        if (killed) return;
        clearInterval(heartbeat);
        resolve(`Command execution failed:\n${String(err)}`);
      });
    });
  }
}

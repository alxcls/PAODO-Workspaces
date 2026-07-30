// Agent tool that spawns a bash command in the workspace directory.
// Streams stdout and stderr live to connected WebSocket clients so they appear in the console panel,
// and returns the combined output to the agent as the tool result.

import { StructuredTool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLogger } from "../../infra/logger";
import { checkFreeSpace, RESERVED_FREE_BYTES } from "../../workspace/diskSpace";
import type { StreamingExecFn, BackgroundExecFn, ExecConfig } from "../interfaces";

const schema = z.object({
  command: z.string().describe("The bash command to execute"),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Set true to run the command in the background: it returns immediately and keeps running " +
        "(you do NOT need a trailing '&'). Output is written to a log file whose path is " +
        "returned; read it later with execute_command (e.g. tail -n 200 <path>). Stop it with stop_task.",
    ),
});

// Maps known stderr signatures to actionable user guidance appended to the tool result.
// Returns "" when stderr is empty so callers can filter it out cleanly.
function diagnoseStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  let out = `[stderr]: ${trimmed}`;
  if (trimmed.includes("no matching entries in passwd file")) {
    out +=
      "\n[setup] The workspace container is stale. The user needs to run: docker rmi paodo-workspace && docker rm ws_<id> — the server will rebuild automatically on the next command.";
  } else if (trimmed.includes("Permission denied")) {
    out +=
      "\n[permission] You run as a non-root user and cannot modify system paths (e.g. /etc, /root, /usr). For workspace files, check ownership; to install system packages use the apt_install tool instead of apt-get.";
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
  // Runner skips the WS tool_result_log broadcast for this tool — output already streams live.
  readonly suppressResultNotify = true;

  private readonly log = createLogger("execCommand");

  constructor(
    private readonly streamExec: StreamingExecFn,
    private readonly backgroundExec: BackgroundExecFn,
    private readonly broadcast: (msg: string) => void,
    private readonly execConfig: ExecConfig,
    private readonly workspaceDir: string,
  ) {
    super();
  }

  protected async _call(
    { command, run_in_background }: z.infer<typeof schema>,
    _runManager?: unknown,
    config?: RunnableConfig,
  ): Promise<string> {
    // Refuse to even start a command — foreground or background — on a workspace that's already out
    // of room. Unlike an HTTP upload there's no declared size for an arbitrary shell command, so this
    // is a headroom gate ("is there still room at all"), not a size check.
    const space = await checkFreeSpace(this.workspaceDir, 0, RESERVED_FREE_BYTES);
    if (!space.ok) {
      this.log.warn(
        { event: "exec_insufficient_storage", freeBytes: space.freeBytes },
        "command refused — low disk space",
      );
      return "Error: workspace is out of free disk space. Free up space (e.g. delete unneeded files) before running more commands.";
    }

    // Background path: launch detached and return immediately. Deliberately skips the
    // heartbeat/AbortController machinery below — a background process is fire-and-forget, so no
    // silence/max timeout kill can ever reach it (that kill is exactly what broke servers before).
    if (run_in_background) {
      try {
        const { taskId, logFile } = await this.backgroundExec(command);
        this.broadcast(
          JSON.stringify({ type: "stdout", data: `\n[background] started task ${taskId} → ${logFile}\n` }),
        );
        return (
          `Command running in background with task ID: ${taskId}\n` +
          `Output is being written to: ${logFile}\n` +
          `Read it with: execute_command "tail -n 200 ${logFile}". Stop it with stop_task.`
        );
      } catch (err) {
        return `Error: failed to start background command\n${String(err)}`;
      }
    }
    // The user's escape signal (threaded by the runner) and our own timeout/silence guards all
    // converge on one AbortController. Aborting it triggers the real in-container process-group
    // kill inside streamExec — there is no longer any "discard output but keep running" path.
    const userSignal = config?.signal;
    return new Promise<string>((resolve) => {
      let stdout = "";
      let stderr = "";
      const startedAt = Date.now();
      let lastOutputAt = Date.now();
      let settled = false;
      const ctrl = new AbortController();

      const onUserAbort = () => killWith("Stopped by user.");

      const finish = (msg: string) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        userSignal?.removeEventListener("abort", onUserAbort);
        resolve(msg);
      };

      const killWith = (reason: string) => {
        if (settled) return;
        this.log.warn({ commandChars: command.length, reason }, "command killed");
        this.broadcast(JSON.stringify({ type: "stdout", data: `\n[killed] ${reason}\n` }));
        ctrl.abort(); // real kill: streamExec tears down the process group
        finish(`[killed] ${reason}`); // unblock the agent immediately
      };

      // statfs is I/O, so the disk check below runs alongside (not inside) the synchronous
      // timeout/silence checks each tick — guarded against overlap since a check can outlive one 5s
      // interval.
      let diskCheckInFlight = false;

      // "Still running" is reassurance, not information — it only needs to be frequent while the
      // user is still deciding whether the command hung. Past 30s of silence it backs off to every
      // 30s, so a quiet 5-minute install prints ~15 lines instead of ~59.
      let lastHeartbeatAt = 0;

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
          const interval = silentMs < 30_000 ? 5_000 : 30_000;
          if (now - lastHeartbeatAt >= interval) {
            lastHeartbeatAt = now;
            this.broadcast(JSON.stringify({ type: "stdout", data: `⏳ still running... (${elapsed}s elapsed)\n` }));
          }
        }

        // A long-running command (git clone, npm install, a build) can fill the disk after it
        // already passed the pre-flight check above — this is the mid-run counterpart, reusing the
        // exact same kill machinery as the timeout guards, just a distinct reason string.
        if (!diskCheckInFlight) {
          diskCheckInFlight = true;
          checkFreeSpace(this.workspaceDir, 0, RESERVED_FREE_BYTES)
            .then((result) => {
              if (!result.ok) killWith("Command killed: workspace ran out of disk space.");
            })
            .catch((err) => this.log.warn({ err }, "disk-space check during command execution failed"))
            .finally(() => {
              diskCheckInFlight = false;
            });
        }
      }, 5_000);

      if (userSignal) {
        if (userSignal.aborted) onUserAbort();
        else userSignal.addEventListener("abort", onUserAbort, { once: true });
      }

      // streamExec handles ensureContainer + docker exec; we route output and feed it the abort
      // signal so a kill reaches the actual in-container process.
      this.streamExec(["/bin/bash", "-c", command], {
        signal: ctrl.signal,
        onStdout: (text) => {
          if (settled) return;
          lastOutputAt = Date.now();
          stdout += text;
          this.broadcast(JSON.stringify({ type: "stdout", data: text }));
        },
        onStderr: (text) => {
          if (settled) return;
          lastOutputAt = Date.now();
          stderr += text;
          this.broadcast(JSON.stringify({ type: "stderr", data: text }));
        },
      })
        .then(({ code }) => {
          if (settled) return;
          this.broadcast(JSON.stringify({ type: "exec_done", exitCode: code }));
          const stderrOut = diagnoseStderr(stderr);
          // Lead a non-zero exit with an explicit Error line so both the agent and the usage
          // dashboard can tell the command failed — the combined output alone hides exit status.
          // (code 0 and null/unknown exits are left as plain output, as before.)
          const failed = typeof code === "number" && code !== 0;
          const parts = [failed ? `Error: command exited with code ${code}` : "", stdout.trim(), stderrOut].filter(
            Boolean,
          );
          finish(parts.join("\n") || "Command executed successfully with no output.");
        })
        .catch((err) => {
          if (settled) return;
          // Lead with "Error:" so runner.classifyToolStatus tags this as a failure (red dot) —
          // same convention as the non-zero exit path above.
          finish(`Error: command execution failed\n${String(err)}`);
        });
    });
  }
}

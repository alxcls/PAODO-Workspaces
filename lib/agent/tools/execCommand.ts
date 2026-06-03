// Agent tool that spawns a bash command in the workspace directory.
// Streams stdout and stderr live to connected WebSocket clients so they appear in the console panel,
// and returns the combined output to the agent as the tool result.
//
// When the *program being executed* is a privileged script (the first token, or the script argument
// of an interpreter like `bash`/`python`), the tool re-routes execution to root with workspace
// secrets injected. Only that single program runs as root: the command is parsed with a quote-aware
// lexer and executed as a direct argv (no `/bin/bash -c`), and any shell operators (; && | < > $() …)
// are refused. This stops the agent from smuggling extra commands to root by naming a privileged path
// as a decoy token or chaining onto a legitimate invocation. Non-privileged commands run as the
// `developer` (or `agent`) user through a normal shell, unchanged.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn } from "child_process";
import { broadcastToWorkspace } from "../../infra/wsHub";
import { ensureContainer } from "../../infra/containerManager";
import { getGlobalLock } from "../../infra/permissionStore";
import { isPrivileged } from "../../infra/privilegeStore";
import { getSecretEnvArgs } from "../../infra/secretStore";
import { createLogger } from "../../infra/logger";

const RESTRICTED_USER = "agent";
const SILENCE_TIMEOUT_MS = parseInt(process.env.EXEC_SILENCE_TIMEOUT_MS ?? "", 10) || 60_000;
const MAX_TIMEOUT_MS = parseInt(process.env.EXEC_MAX_TIMEOUT_MS ?? "", 10) || 30 * 60_000;

// Programs that run a script handed to them as an argument — language interpreters (`bash deploy.sh`,
// `python3 -u build.py`) and JS/TS launchers (`npx tsx script.ts`, `ts-node script.ts`). The
// privileged target is the first non-flag token AFTER any chain of these, so nested launchers like
// `npx tsx <script>` resolve to the script itself, not to `npx`.
const INTERPRETERS = new Set([
  "bash", "sh", "dash", "zsh", "ksh", "python", "python3", "ruby", "perl", "php",
  "node", "npx", "tsx", "ts-node",
]);

// Shell metacharacters that introduce additional commands, redirection, or substitution. A privileged
// invocation must contain none of them (outside quotes): each would otherwise run as root too.
const OPERATOR_CHARS = new Set([";", "&", "|", "<", ">", "$", "`", "(", ")", "\n"]);

// Quote-aware tokenizer. Splits on unquoted whitespace, keeps quoted spans literal (no expansion),
// and flags any unquoted shell operator. It does NOT interpret the shell — it only extracts the argv
// well enough to (a) identify the program and (b) confirm the command is a single plain invocation.
// Used solely to gate privileged routing; non-privileged commands bypass it and keep full shell power.
function lexCommand(command: string): { tokens: string[]; hadOperator: boolean; error?: string } {
  const tokens: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  let hadOperator = false;
  for (const c of command) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      started = true;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === " " || c === "\t") {
      if (started) { tokens.push(cur); cur = ""; started = false; }
    } else if (OPERATOR_CHARS.has(c)) {
      hadOperator = true;
      if (started) { tokens.push(cur); cur = ""; started = false; }
    } else {
      cur += c;
      started = true;
    }
  }
  if (quote) return { tokens, hadOperator, error: "unbalanced quote" };
  if (started) tokens.push(cur);
  return { tokens, hadOperator };
}

// Normalizes a token to a workspace-relative path for the privilege-registry lookup (mirrors the
// path forms the agent may use: absolute /workspace/..., ./relative, or bare relative).
function toWorkspaceRel(token: string): string {
  if (token.startsWith("/workspace/")) return token.slice("/workspace/".length);
  if (token.startsWith("./")) return token.slice(2);
  return token;
}

// The program a command actually runs: walk past any chain of interpreter/launcher tokens and their
// flags (e.g. `npx tsx --flag <script>`) to reach the first real target token. Returns null if the
// command is only interpreters/flags. The target must still sit immediately after the launcher chain —
// junk before it (`npx tsx junk script.ts`) resolves to the junk, so a privileged script only elevates
// when it's the genuine program, never when buried as a later argument.
function resolveProgramRel(tokens: string[]): string | null {
  let i = 0;
  while (i < tokens.length) {
    const rel = toWorkspaceRel(tokens[i]);
    const base = rel.split("/").pop() ?? rel;
    if (INTERPRETERS.has(base)) {
      i++;
      while (i < tokens.length && tokens[i].startsWith("-")) i++;
      continue;
    }
    return rel;
  }
  return null;
}

export function buildExecCommandTool(workspaceId: string, workspaceDir: string) {
  const log = createLogger("execCommand");
  return tool(
    async ({ command }) => {
      // Privileged routing gate: only the actual program being run (the first token, or the script
      // argument of an interpreter) may elevate to root — NOT any path that merely appears as a
      // token. This stops the agent from smuggling commands to root by naming a privileged path as a
      // decoy (`chmod ...; : deploy.sh`) or wrapping it in another program (`cat deploy.sh`).
      const lex = lexCommand(command);
      const programRel = resolveProgramRel(lex.tokens);
      const isPrivilegedCommand = programRel !== null && isPrivileged(workspaceId, programRel);

      if (isPrivilegedCommand) {
        // The invocation must be a single plain command: an unbalanced quote leaves the argv
        // ambiguous, and any shell operator (chaining, pipe, redirection, substitution) would also
        // run as root. Refuse both — legitimate piping/redirection belongs INSIDE the trusted script.
        if (lex.error) {
          return `Refused: could not parse the privileged invocation (${lex.error}). Invoke the script plainly: <script> [args...].`;
        }
        if (lex.hadOperator) {
          return "Refused: a privileged script must be invoked on its own, without shell operators "
            + "(; && || | < > $() ` etc.). Move any chaining, piping, or redirection inside the "
            + "trusted script itself, then re-run it as just: <script> [args...].";
        }
        // Privileged script: run ONLY this program as root (direct argv — no shell to inject into),
        // with workspace secrets injected. Arguments are passed literally and never interpreted.
        await ensureContainer(workspaceId, workspaceDir);
        const secretArgs = getSecretEnvArgs(workspaceId);
        log.info({ workspaceId, command }, "auto-routing privileged script");

        return new Promise<string>((resolve) => {
          const proc = spawn("docker", [
            "exec", "-i", "-u", "root", ...secretArgs,
            "-w", "/workspace", `ws_${workspaceId}`,
            ...lex.tokens,
          ]);
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
            broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stdout", workspaceId, data: `\n[timeout] ${reason}\n` }));
          };

          const heartbeat = setInterval(() => {
            const now = Date.now();
            const silentMs = now - lastOutputAt;
            const elapsedMs = now - startedAt;
            const elapsed = Math.round(elapsedMs / 1000);
            if (elapsedMs >= MAX_TIMEOUT_MS) { killWith(`Script killed after ${elapsed}s (max runtime exceeded).`); return; }
            if (silentMs >= SILENCE_TIMEOUT_MS) { killWith(`Script killed after ${Math.round(silentMs / 1000)}s with no output.`); return; }
            if (silentMs >= 5_000) broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stdout", workspaceId, data: `⏳ still running... (${elapsed}s elapsed)\n` }));
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
            const stderrOut = stderr.trim() ? `[stderr]: ${stderr.trim()}` : "";
            const parts = [stdout.trim(), stderrOut].filter(Boolean);
            resolve(parts.join("\n") || "Script executed successfully with no output.");
          });
          proc.on("error", (err) => { clearInterval(heartbeat); resolve(`Script execution failed:\n${err.message}`); });
        });
      }

      const [, isLocked] = await Promise.all([
        ensureContainer(workspaceId, workspaceDir),
        getGlobalLock(workspaceId),
      ]);
      const userArgs = isLocked ? ["-u", RESTRICTED_USER] : ["-u", "developer"];

      return new Promise<string>((resolve) => {
        const proc = spawn("docker", ["exec", "-i", ...userArgs, "-w", "/workspace", `ws_${workspaceId}`, "/bin/bash", "-c", command]);
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
          if (elapsedMs >= MAX_TIMEOUT_MS) { killWith(`Command killed after ${elapsed}s (max runtime exceeded).`); return; }
          if (silentMs >= SILENCE_TIMEOUT_MS) { killWith(`Command killed after ${Math.round(silentMs / 1000)}s with no output.`); return; }
          if (silentMs >= 5_000) broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stdout", workspaceId, data: `⏳ still running... (${elapsed}s elapsed)\n` }));
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
            stderrOut += isLocked
              ? "\n[permission] The workspace is globally locked [R] — commands run as a restricted user that cannot write files or install packages. Ask the user to unlock the workspace first."
              : "\n[permission] One or more files involved are read-only [R]. Use list_directory or glob to check permissions before retrying.";
          }
          const parts = [stdout.trim(), stderrOut].filter(Boolean);
          resolve(parts.join("\n") || "Command executed successfully with no output.");
        });
        proc.on("error", (err) => { clearInterval(heartbeat); resolve(`Command execution failed:\n${err.message}`); });
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

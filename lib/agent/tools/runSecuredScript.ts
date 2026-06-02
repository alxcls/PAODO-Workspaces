// Agent tool that runs a user-secured script with workspace secrets injected.
//
// This is the ONLY path by which a script gets workspace secrets. The agent supplies just a
// script PATH — never a command string — and the server composes a FIXED `docker exec -u root`
// command with the secrets injected via `-e`. Because the agent runs `execute_command` as the
// non-root `developer` user (no secrets, cannot become root, cannot read the running script's
// /proc environ), it cannot read the secret values nor turn this into an arbitrary root command.
// Only the user can secure a script (file-tree key icon); the agent has no tool to secure.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn } from "child_process";
import path from "path";
import { broadcastToWorkspace } from "../../infra/wsHub";
import { ensureContainer } from "../../infra/containerManager";
import { getSecretEnvArgs } from "../../infra/secretStore";
import { isSecured, listSecured } from "../../infra/securedScriptStore";
import { createLogger } from "../../infra/logger";

const SILENCE_TIMEOUT_MS = parseInt(process.env.EXEC_SILENCE_TIMEOUT_MS ?? "", 10) || 60_000;
const MAX_TIMEOUT_MS = parseInt(process.env.EXEC_MAX_TIMEOUT_MS ?? "", 10) || 30 * 60_000;

function normalizeRelpath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
  return normalized;
}

// Maps an extension to the interpreter argv prefix. The interpreter + absolute path are fixed by
// the server — the agent cannot inject flags or extra commands.
function interpreterFor(relPath: string): string[] {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".py") return ["python3"];
  if (ext === ".js" || ext === ".mjs") return ["node"];
  return ["bash"];
}

export function buildRunSecuredScriptTool(workspaceId: string, workspaceDir: string) {
  const log = createLogger("runSecuredScript");
  return tool(
    async ({ script_path }) => {
      const relPath = normalizeRelpath(script_path);
      if (relPath === null) return "Error: path is outside the workspace";

      if (!isSecured(workspaceId, relPath)) {
        const secured = listSecured(workspaceId);
        if (secured.length === 0) {
          return "No secured scripts available. Only the user can secure a script (the key icon next to a file in the file tree). The agent cannot secure scripts. Ask the user to secure the script before it can run with secrets injected.";
        }
        return `"${script_path}" is not secured. Only the user can secure a script via the file tree. Available secured scripts:\n${secured.map((p) => `  - ${p}`).join("\n")}`;
      }

      await ensureContainer(workspaceId, workspaceDir);
      const secretArgs = getSecretEnvArgs(workspaceId);
      const interp = interpreterFor(relPath);

      return new Promise<string>((resolve) => {
        const proc = spawn("docker", [
          "exec", "-i", "-u", "root", ...secretArgs,
          "-w", "/workspace", `ws_${workspaceId}`,
          ...interp, `/workspace/${relPath}`,
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
          log.warn({ workspaceId, script_path, reason }, "secured script killed");
          broadcastToWorkspace(workspaceId, JSON.stringify({ type: "stdout", workspaceId, data: `\n[timeout] ${reason}\n` }));
        };

        const heartbeat = setInterval(() => {
          const now = Date.now();
          const silentMs = now - lastOutputAt;
          const elapsedMs = now - startedAt;
          const elapsed = Math.round(elapsedMs / 1000);
          if (elapsedMs >= MAX_TIMEOUT_MS) {
            killWith(`Script killed after ${elapsed}s (max runtime exceeded).`);
            return;
          }
          if (silentMs >= SILENCE_TIMEOUT_MS) {
            killWith(`Script killed after ${Math.round(silentMs / 1000)}s with no output.`);
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
          const stderrOut = stderr.trim() ? `[stderr]: ${stderr.trim()}` : "";
          const parts = [stdout.trim(), stderrOut].filter(Boolean);
          resolve(parts.join("\n") || "Script executed successfully with no output.");
        });

        proc.on("error", (err) => {
          clearInterval(heartbeat);
          resolve(`Script execution failed:\n${err.message}`);
        });
      });
    },
    {
      name: "run_secured_script",
      description: `Run a user-secured script with workspace secrets injected into its environment.
Use this INSTEAD of execute_command whenever a task needs access to a secret (API key, token, credential).
Only scripts the user has explicitly secured (the key icon in the file tree) can be run this way — you
cannot secure scripts yourself, and plain execute_command will NOT have the secrets in its environment.
You supply only the script path; you cannot read the secret values.
Supported extensions: .py (python3), .js/.mjs (node), everything else (bash).`,
      schema: z.object({
        script_path: z.string().describe("Relative path to the secured script within the workspace"),
      }),
    }
  );
}

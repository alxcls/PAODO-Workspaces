// Agent tool that runs a user-crowned script with workspace secrets injected.
//
// This is the ONLY path by which a script gets workspace secrets. The agent supplies just a
// script PATH — never a command string — and the server composes a FIXED `docker exec -u root`
// command with the secrets injected via `-e`. Because the agent runs `execute_command` as the
// non-root `developer` user (no secrets, cannot become root, cannot read the running script's
// /proc environ), it cannot read the secret values nor turn this into an arbitrary root command.
// Only the user can crown a script (file-tree crown icon); the agent has no tool to crown.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { spawn } from "child_process";
import path from "path";
import { broadcastToWorkspace } from "../../infra/wsHub";
import { ensureContainer } from "../../infra/containerManager";
import { getSecretEnvArgs } from "../../infra/secretStore";
import { isCrowned, listCrowned } from "../../infra/crownedScriptStore";
import { listWorkspacePaths, lockPathOnDisk } from "../../infra/osLock";
import { readPermissionSnapshot, setPermission } from "../../infra/permissionStore";
import { createLogger } from "../../infra/logger";

const SILENCE_TIMEOUT_MS = parseInt(process.env.EXEC_SILENCE_TIMEOUT_MS ?? "", 10) || 60_000;
const MAX_TIMEOUT_MS = parseInt(process.env.EXEC_MAX_TIMEOUT_MS ?? "", 10) || 30 * 60_000;

function normalizeRelpath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
  return normalized;
}

// Files/folders a crowned (root) script CREATES are its protected outputs: we register them as
// locked [R] so the agent can read/run but not overwrite them — at both the registry layer
// (file_write/file_edit refuse [R]) and the OS layer (root:root 0444). Outputs are found by diffing
// the workspace path set before vs. after the run (NOT by ownership — on macOS virtiofs every file
// reports as root, which would match the whole tree). Files the script merely OVERWRITES already
// existed, so they aren't auto-locked. Skips already-locked/crowned paths and children of a path
// we're already registering (sorted ascending so a parent dir precedes its contents). Never throws.
async function protectCrownedOutputs(
  workspaceId: string,
  before: Set<string>,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    const snap = await readPermissionSnapshot(workspaceId);
    if (snap.globalLock) return; // globally locked → read-only mount, nothing to register
    const isLockedRel = (rel: string) => snap.locked.some((p) => p === rel || rel.startsWith(p + "/"));

    const candidates = (await listWorkspacePaths(workspaceId))
      .filter((rel) => !before.has(rel) && !isLockedRel(rel) && !isCrowned(workspaceId, rel))
      .sort();

    const registered: string[] = [];
    for (const rel of candidates) {
      if (registered.some((p) => rel === p || rel.startsWith(p + "/"))) continue; // covered by an ancestor
      registered.push(rel);
      await setPermission(workspaceId, rel, "R");
      await lockPathOnDisk(workspaceId, rel);
    }
    if (registered.length > 0) log.info({ workspaceId, count: registered.length }, "locked crowned-script outputs");
  } catch (err) {
    log.warn({ workspaceId, err }, "failed to protect crowned-script outputs");
  }
}

// Maps an extension to the interpreter argv prefix. The interpreter + absolute path are fixed by
// the server — the agent cannot inject flags or extra commands.
function interpreterFor(relPath: string): string[] {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".py") return ["python3"];
  if (ext === ".js" || ext === ".mjs") return ["node"];
  return ["bash"];
}

export function buildRunCrownedScriptTool(workspaceId: string, workspaceDir: string) {
  const log = createLogger("runCrownedScript");
  return tool(
    async ({ script_path }) => {
      const relPath = normalizeRelpath(script_path);
      if (relPath === null) return "Error: path is outside the workspace";

      if (!isCrowned(workspaceId, relPath)) {
        const crowned = listCrowned(workspaceId);
        if (crowned.length === 0) {
          return "No crowned scripts available. Only the user can crown a script (the crown icon next to a file in the file tree). The agent cannot crown scripts. Ask the user to crown the script before it can run with secrets injected.";
        }
        return `"${script_path}" is not crowned. Only the user can crown a script via the file tree. Available crowned scripts:\n${crowned.map((p) => `  - ${p}`).join("\n")}`;
      }

      await ensureContainer(workspaceId, workspaceDir);
      const secretArgs = getSecretEnvArgs(workspaceId);
      const interp = interpreterFor(relPath);
      // Snapshot paths before the run so we can lock only the outputs the script CREATES (diff).
      const before = new Set(await listWorkspacePaths(workspaceId));

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
          log.warn({ workspaceId, script_path, reason }, "crowned script killed");
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

        proc.on("close", async (code) => {
          clearInterval(heartbeat);
          // Protect anything the (root) script created: register new paths as locked.
          await protectCrownedOutputs(workspaceId, before, log);
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
      name: "run_crowned_script",
      description: `Run a user-crowned script with workspace secrets injected into its environment.
Use this INSTEAD of execute_command whenever a task needs access to a secret (API key, token, credential).
Only scripts the user has explicitly crowned (the crown icon in the file tree) can be run this way — you
cannot crown scripts yourself, and plain execute_command will NOT have the secrets in its environment.
You supply only the script path; you cannot read the secret values.
Supported extensions: .py (python3), .js/.mjs (node), everything else (bash).`,
      schema: z.object({
        script_path: z.string().describe("Relative path to the crowned script within the workspace"),
      }),
    }
  );
}

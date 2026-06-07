import { tool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import { dockerExec } from "@/lib/infra/containerManager";
import { readPermissionSnapshot, isKeyedFromSnapshot } from "@/lib/infra/permissionStore";
import { RUNTIME_PREFIX } from "@/lib/utils/fileType";
import type { RuntimeKey } from "@/lib/utils/fileType";

function normalizeRelPath(inputPath: string): string | null {
  if (inputPath.startsWith("/workspace/")) {
    return inputPath.slice("/workspace/".length);
  }
  const normalized = path.posix.normalize(inputPath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
  return normalized;
}

export function buildRunKeyedScriptTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ path: inputPath, runtime, args }) => {
      const relPath = normalizeRelPath(inputPath);
      if (relPath === null) {
        return "Error: path is outside the workspace. Use a workspace-relative path or /workspace/<path>.";
      }

      const snapshot = await readPermissionSnapshot(workspaceId);
      if (snapshot.globalLock) {
        return "Error: workspace is globally locked. Unlock the workspace before running keyed scripts.";
      }
      if (!isKeyedFromSnapshot(snapshot, relPath)) {
        return `Error: "${relPath}" is not marked [keyed]. Toggle the key icon in the file tree to enable privileged execution.`;
      }

      const scriptAbs = `/workspace/${relPath}`;
      const extraArgs = args ?? [];

      let cmdArgs: string[];
      if (runtime) {
        const prefix = RUNTIME_PREFIX[runtime];
        if (!prefix) {
          return "Error: unsupported runtime. Use a supported runtime or a wrapper script.";
        }
        cmdArgs = [...prefix, scriptAbs, ...extraArgs];
      } else {
        cmdArgs = [scriptAbs, ...extraArgs];
      }

      const scriptDir = path.posix.dirname(relPath);
      const cwd = scriptDir === "." ? "/workspace" : `/workspace/${scriptDir}`;
      const result = await dockerExec(workspaceId, workspaceDir, cmdArgs, { asPrivd: true, cwd });
      if (result.code !== 0) {
        const stderr = result.stderr || "unknown error";
        return `Error (run_keyed_script exit ${result.code}): ${stderr}`;
      }
      return result.stdout || "Command executed successfully with no output.";
    },
    {
      name: "run_keyed_script",
      description:
        "Run a [keyed] script as the privileged user (uid 998). " +
        "Use this instead of sudo inside execute_command. " +
        "The path must be inside the workspace and marked [keyed] in the file tree.",
      schema: z.object({
        path: z
          .string()
          .describe("Workspace-relative path or /workspace/<path> to a keyed script, e.g. scripts/migrate.py"),
        runtime: z
          .enum(
            [
              "python",
              "python3",
              "node",
              "bash",
              "sh",
              "go_run",
              "ruby",
              "php",
              "perl",
              "deno_run",
              "java_jar",
              "dotnet",
              "lua",
              "rscript",
              "swift",
              "awk",
              "tcl",
            ] as [RuntimeKey, ...RuntimeKey[]],
          )
          .optional()
          .describe(
            "Optional runtime mode for the script. Supported values: " +
              "'python', 'python3', 'node', 'bash', 'sh', 'go_run' (for 'go run'), 'ruby', 'php', 'perl', " +
              "'deno_run' (for 'deno run'), 'java_jar' (for 'java -jar'), 'dotnet', " +
              "'lua', 'rscript' (for Rscript), 'swift', 'awk' (for 'awk -f'), 'tcl' (for tclsh). " +
              "If omitted, the script is executed directly.",
          ),
        args: z
          .array(z.string())
          .optional()
          .describe("Optional list of additional CLI arguments for the script."),
      }),
    },
  );
}

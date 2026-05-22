// Agent tool that lists the contents of a workspace directory.
// Returns entries sorted with directories first, each annotated with type (d/-)  and human-readable file size.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { isAgentLocked } from "@/lib/infra/permissionStore";

export function buildListDirectoryTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ dir_path }) => {
      const wsReal = await fs.realpath(workspaceDir);
      const abs = await fs.realpath(path.resolve(workspaceDir, dir_path ?? ".")).catch(() => null);
      if (!abs || (!abs.startsWith(wsReal + path.sep) && abs !== wsReal))
        return "Error: path is outside the workspace";
      try {
        const entries = await fs.readdir(abs, { withFileTypes: true });
        if (entries.length === 0) return "(empty directory)";
        const lines = await Promise.all(
          entries
            .sort((a, b) => {
              // Directories first, then files, both alphabetical
              if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map(async (entry) => {
              const full = path.join(abs, entry.name);
              const stat = await fs.stat(full).catch(() => null);
              const size = stat && !entry.isDirectory() ? `  ${formatSize(stat.size)}` : "";
              const suffix = entry.isDirectory() ? "/" : "";
              const perm = (await isAgentLocked(workspaceId, workspaceDir, full)) ? " [R]" : " [RW]";
              return `${entry.isDirectory() ? "d" : "-"}  ${entry.name}${suffix}${size}${perm}`;
            })
        );
        return lines.join("\n");
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "list_directory",
      description: `List the contents of a directory in the workspace. Returns entries sorted with directories first.
Each line: type (d=directory, -=file), name, and file size.
Use this instead of ls. For recursive or pattern-based search use glob instead.`,
      schema: z.object({
        dir_path: z.string().optional().describe("Directory path relative to workspace root. Omit or use '.' for the workspace root."),
      }),
    }
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

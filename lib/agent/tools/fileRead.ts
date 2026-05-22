import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { isAgentLocked } from "@/lib/infra/permissionStore";

export function buildFileReadTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ file_path, offset, limit }) => {
      const wsReal = await fs.realpath(workspaceDir);
      const abs = await fs.realpath(path.resolve(workspaceDir, file_path)).catch(() => null);
      if (!abs || (!abs.startsWith(wsReal + path.sep) && abs !== wsReal))
        return "Error: path is outside the workspace";
      try {
        const perm = (await isAgentLocked(workspaceId, workspaceDir, abs)) ? "[R]" : "[RW]";
        const header = `${perm} ${file_path}\n`;
        const raw = await fs.readFile(abs, "utf8");
        const lines = raw.split("\n");
        const start = offset ?? 0;
        const slice = limit !== undefined ? lines.slice(start, start + limit) : lines.slice(start);
        return header + slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "file_read",
      description: `Read a file from the workspace. Returns content with line numbers (cat -n format).
Use this instead of cat, head, or tail.

- file_path is relative to the workspace root.
- Use offset + limit to read only part of a large file (e.g. offset:49, limit:50 reads lines 50–99).
- You MUST read a file with this tool before editing it with file_edit.`,
      schema: z.object({
        file_path: z.string().describe("File path relative to workspace root"),
        offset: z.number().int().min(0).optional().describe("Line index to start from (0-based). Omit to start from the beginning."),
        limit: z.number().int().min(1).optional().describe("Maximum number of lines to return. Omit to read to end of file."),
      }),
    }
  );
}

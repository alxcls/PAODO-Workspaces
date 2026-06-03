// Tool that reads a workspace file and returns its content with line numbers (cat -n format).
// File access is routed through the per-workspace Docker container for OS-level isolation.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import { isAgentLocked } from "@/lib/infra/permissionStore";
import { isPrivileged } from "@/lib/infra/privilegeStore";
import { isHidden } from "@/lib/infra/hiddenStore";
import { dockerExec } from "@/lib/infra/containerManager";
import { permissionTags } from "./tags";
import { normalizeRelpath } from "./pathUtils";

export function buildFileReadTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ file_path, offset, limit }) => {
      const relpath = normalizeRelpath(file_path);
      if (relpath === null) return "Error: path is outside the workspace";
      try {
        const hidden = isHidden(workspaceId, relpath);
        const tags = permissionTags({
          locked: await isAgentLocked(workspaceId, workspaceDir, path.join(workspaceDir, relpath)),
          privileged: isPrivileged(workspaceId, relpath),
          hidden,
        });
        const header = `${tags} ${file_path}\n`;

        // Hidden files: the user has marked the content invisible to the agent. The OS already
        // blocks the read, but return a clean message instead of letting cat fail with EACCES.
        if (hidden) return header + "content hidden by the user";

        if (offset === undefined && limit === undefined) {
          const r = await dockerExec(workspaceId, workspaceDir, ["cat", `/workspace/${relpath}`]);
          if (r.code !== 0) return `Error: ${r.stderr || "file not found or unreadable"}`;
          const lines = r.stdout.split("\n");
          return header + lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
        } else {
          // sed uses 1-based line numbers; offset is 0-based
          const startLine = (offset ?? 0) + 1;
          const endLine = limit !== undefined ? (offset ?? 0) + limit : "$";
          const r = await dockerExec(workspaceId, workspaceDir, [
            "sed", "-n", `${startLine},${endLine}p`, `/workspace/${relpath}`,
          ]);
          if (r.code !== 0) return `Error: ${r.stderr || "file not found or unreadable"}`;
          const start = offset ?? 0;
          const lines = r.stdout.split("\n");
          return header + lines.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
        }
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

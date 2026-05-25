// Agent tool that writes full content to a file in the workspace, creating intermediate directories as needed.
// Intended for new files or complete rewrites — for targeted changes to existing files prefer file_edit.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { isAgentLocked } from "@/lib/infra/permissionStore";

export function buildFileWriteTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ file_path, content }) => {
      const wsReal = await fs.realpath(workspaceDir);
      const candidate = path.resolve(workspaceDir, file_path);
      let abs: string;
      try {
        abs = await fs.realpath(candidate);
      } catch {
        const parentReal = await fs.realpath(path.dirname(candidate)).catch(() => null);
        if (!parentReal) return "Error: path is outside the workspace";
        abs = path.join(parentReal, path.basename(candidate));
      }
      if (!abs.startsWith(wsReal + path.sep) && abs !== wsReal)
        return "Error: path is outside the workspace";
      try {
        const exists = await fs.access(abs).then(() => true).catch(() => false);
        if (exists) {
          if (await isAgentLocked(workspaceId, workspaceDir, abs)) {
            throw new Error(`"${file_path}" is read-only [R] — ask the user to click the lock icon in the file tree to unlock it.`);
          }
        } else {
          if (await isAgentLocked(workspaceId, workspaceDir, path.dirname(abs))) {
            throw new Error(`The target directory is locked [R] — ask the user to click the lock icon in the file tree to unlock it.`);
          }
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
        return `Written ${file_path} (${content.length} chars)`;
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "file_write",
      description: `Write full content to a file, creating or overwriting it.
ALWAYS use this when the user asks you to "write", "create", or "save" a file — never output the content as a code block in text.
Use for creating new files or complete rewrites. For targeted edits to existing files, prefer file_edit.
If the file already exists and you need to preserve or merge its content, read it first with file_read. If you are replacing it wholesale or creating a new file, skip the read.
If file_read shows [R] for the file, or list_directory shows [R] for the target directory, DO NOT call this tool — tell the user the file or folder is locked instead.`,
      schema: z.object({
        file_path: z.string().describe("File path relative to workspace root"),
        content: z.string().describe("Full content to write to the file"),
      }),
    }
  );
}

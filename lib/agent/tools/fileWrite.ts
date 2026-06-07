// Agent tool that writes full content to a file in the workspace, creating intermediate directories as needed.
// File access is routed through the per-workspace Docker container for OS-level isolation.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import { dockerExec } from "@/lib/infra/containerManager";

function normalizeRelpath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
  return normalized;
}

export function buildFileWriteTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ file_path, content }) => {
      const relpath = normalizeRelpath(file_path);
      if (relpath === null) return "Error: path is outside the workspace";
      try {
        const dirRelpath = path.posix.dirname(relpath);
        if (dirRelpath && dirRelpath !== ".") {
          const mkdirR = await dockerExec(workspaceId, workspaceDir, [
            "mkdir", "-p", `/workspace/${dirRelpath}`,
          ]);
          if (mkdirR.code !== 0) return `Error: could not create directory: ${mkdirR.stderr}`;
        }

        const writeR = await dockerExec(workspaceId, workspaceDir, [
          "tee", `/workspace/${relpath}`,
        ], { stdin: content });
        if (writeR.code !== 0) return `Error: ${writeR.stderr || "write failed"}`;

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
If the file already exists and you need to preserve or merge its content, read it first with file_read. If you are replacing it wholesale or creating a new file, skip the read.`,
      schema: z.object({
        file_path: z.string().describe("File path relative to workspace root"),
        content: z.string().describe("Full content to write to the file"),
      }),
    }
  );
}

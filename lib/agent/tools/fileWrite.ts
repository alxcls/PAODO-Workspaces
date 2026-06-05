// Agent tool that writes full content to a file in the workspace, creating intermediate directories as needed.
// File access is routed through the per-workspace Docker container for OS-level isolation.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import { isAgentLocked } from "@/lib/infra/permissionStore";
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
        const absFile = path.join(workspaceDir, relpath);
        const absDir = path.dirname(absFile);

        // Check whether the file already exists to decide which lock to enforce
        const statR = await dockerExec(workspaceId, workspaceDir, [
          "find", `/workspace/${relpath}`, "-maxdepth", "0", "-type", "f",
        ], { asAgent: true });
        const fileExists = statR.code === 0 && statR.stdout.trim() !== "";

        if (fileExists) {
          if (await isAgentLocked(workspaceId, workspaceDir, absFile)) {
            throw new Error(`"${file_path}" is locked [locked] — the operator can unlock it in the file tree, or use a keyed script to modify it.`);
          }
        } else {
          if (await isAgentLocked(workspaceId, workspaceDir, absDir)) {
            throw new Error(`The target directory is locked [locked] — the operator can unlock it in the file tree, or use a keyed script to write there.`);
          }
        }

        const dirRelpath = path.posix.dirname(relpath);
        if (dirRelpath && dirRelpath !== ".") {
          const mkdirR = await dockerExec(workspaceId, workspaceDir, [
            "mkdir", "-p", `/workspace/${dirRelpath}`,
          ], { asAgent: true });
          if (mkdirR.code !== 0) return `Error: could not create directory: ${mkdirR.stderr}`;
        }

        const writeR = await dockerExec(workspaceId, workspaceDir, [
          "tee", `/workspace/${relpath}`,
        ], { stdin: content, asAgent: true });
        if (writeR.code !== 0) return `Error: ${writeR.stderr || "write failed"}`;

        // New files written by uid 999 land as owner=999:gid=access, mode from umask.
        // Set to 664 (Normal file mode) explicitly so group bits are always correct.
        await dockerExec(workspaceId, workspaceDir, ["chmod", "664", `/workspace/${relpath}`], { asAgent: true });

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
If list_directory shows the file or target directory is owned by privd (locked), DO NOT call this tool — tell the user the path is locked and ask them to unlock it in the file tree.`,
      schema: z.object({
        file_path: z.string().describe("File path relative to workspace root"),
        content: z.string().describe("Full content to write to the file"),
      }),
    }
  );
}

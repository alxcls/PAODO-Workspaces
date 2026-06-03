// Agent tool that writes full content to a file in the workspace, creating intermediate directories as needed.
// File access is routed through the per-workspace Docker container for OS-level isolation.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import { isAgentLocked } from "@/lib/infra/permissionStore";
import { isHidden } from "@/lib/infra/hiddenStore";
import { dockerExec } from "@/lib/infra/containerManager";
import { normalizeRelpath } from "./pathUtils";

export function buildFileWriteTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ file_path, content }) => {
      const relpath = normalizeRelpath(file_path);
      if (relpath === null) return "Error: path is outside the workspace";
      if (isHidden(workspaceId, relpath)) {
        return `Error: "${file_path}" is hidden [H] — its content is invisible to you and cannot be written. Ask the user to reveal it (eye icon in the file tree) if it needs changing.`;
      }
      try {
        const absFile = path.join(workspaceDir, relpath);
        const absDir = path.dirname(absFile);

        // Check whether the file already exists to decide which lock to enforce
        const statR = await dockerExec(workspaceId, workspaceDir, [
          "find", `/workspace/${relpath}`, "-maxdepth", "0", "-type", "f",
        ]);
        const fileExists = statR.code === 0 && statR.stdout.trim() !== "";

        if (fileExists) {
          if (await isAgentLocked(workspaceId, workspaceDir, absFile)) {
            throw new Error(`"${file_path}" is read-only [R] — ask the user to click the lock icon in the file tree to unlock it.`);
          }
        } else {
          if (await isAgentLocked(workspaceId, workspaceDir, absDir)) {
            throw new Error(`The target directory is locked [R] — ask the user to click the lock icon in the file tree to unlock it.`);
          }
        }

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

        // tee runs as root, so the new file is root-owned. Hand it to `developer` so the agent's
        // own `execute_command` (which runs as developer) can later modify it, and so it matches
        // the canonical unlocked-file ownership. The host app (UID 1000) reads it fine (world-read)
        // and writes via its root docker-exec fallback.
        await dockerExec(workspaceId, workspaceDir, ["chown", "developer:developer", `/workspace/${relpath}`]);

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

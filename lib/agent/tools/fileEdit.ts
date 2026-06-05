// Agent tool that edits a file by replacing an exact string match.
// File I/O is routed through the per-workspace Docker container; string replacement logic stays in Node.js.
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

export function buildFileEditTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ file_path, old_string, new_string, replace_all }) => {
      const relpath = normalizeRelpath(file_path);
      if (relpath === null) return "Error: path is outside the workspace";

      if (old_string === "") {
        // Create new file branch
        const absDir = path.dirname(path.join(workspaceDir, relpath));
        if (await isAgentLocked(workspaceId, workspaceDir, absDir)) {
          return `Error: The target directory is locked [locked] — toggle the lock in the file tree to allow writes.`;
        }
        try {
          const dirRelpath = path.posix.dirname(relpath);
          if (dirRelpath && dirRelpath !== ".") {
            const mkdirR = await dockerExec(workspaceId, workspaceDir, [
              "mkdir", "-p", `/workspace/${dirRelpath}`,
            ], { asAgent: true });
            if (mkdirR.code !== 0) return `Error: could not create directory: ${mkdirR.stderr}`;
          }
          const writeR = await dockerExec(workspaceId, workspaceDir, [
            "tee", `/workspace/${relpath}`,
          ], { stdin: new_string, asAgent: true });
          if (writeR.code !== 0) return `Error: ${writeR.stderr || "write failed"}`;
          return `Created ${file_path}`;
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Edit existing file branch
      const absFile = path.join(workspaceDir, relpath);
      if (await isAgentLocked(workspaceId, workspaceDir, absFile)) {
        return `Error: "${file_path}" is locked [locked] — the operator can unlock it in the file tree, or use a keyed script to modify it.`;
      }
      try {
        // Read exact content — stdout must NOT be trimmed (preserves trailing newlines for correct string matching)
        const readR = await dockerExec(workspaceId, workspaceDir, ["cat", `/workspace/${relpath}`], { asAgent: true });
        if (readR.code !== 0) return `Error: ${readR.stderr || "file not found or unreadable"}`;

        const content = readR.stdout;
        if (!content.includes(old_string)) {
          return `Error: old_string not found in ${file_path}. Ensure exact match including whitespace and indentation.`;
        }
        const count = content.split(old_string).length - 1;
        if (count > 1 && !replace_all) {
          return `Error: old_string appears ${count} times. Add more surrounding lines to make it unique, or set replace_all: true.`;
        }
        const updated = replace_all
          ? content.replaceAll(old_string, new_string)
          : content.replace(old_string, new_string);

        const writeR = await dockerExec(workspaceId, workspaceDir, [
          "tee", `/workspace/${relpath}`,
        ], { stdin: updated, asAgent: true });
        if (writeR.code !== 0) return `Error: ${writeR.stderr || "write failed"}`;
        return `Updated ${file_path}`;
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "file_edit",
      description: `Edit a file by replacing an exact string. Use this instead of sed or awk.

- You MUST call file_read first. Editing a file you haven't read will produce wrong results.
- If list_directory shows the file is owned by privd (locked), DO NOT call this tool — tell the user the file is locked instead.
- old_string must match exactly — including whitespace, indentation, and newlines.
- Fails if old_string appears more than once. Add more surrounding lines for uniqueness, or set replace_all: true.
- Set old_string to "" to create a new file (new_string becomes the full content).`,
      schema: z.object({
        file_path: z.string().describe("File path relative to workspace root"),
        old_string: z.string().describe("Exact text to replace (empty string to create a new file)"),
        new_string: z.string().describe("Replacement text"),
        replace_all: z.boolean().optional().describe("Replace every occurrence instead of just the first (default false)"),
      }),
    }
  );
}

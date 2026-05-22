// Agent tool that edits a file by replacing an exact string match.
// Enforces read-before-edit, handles multi-occurrence conflicts, and supports full replace-all mode.
// Setting old_string to "" creates the file instead of editing it.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { isAgentLocked } from "@/lib/infra/permissionStore";

export function buildFileEditTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ file_path, old_string, new_string, replace_all }) => {
      const wsReal = await fs.realpath(workspaceDir);

      if (old_string === "") {
        // Create new file — resolve path even if file doesn't exist yet
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
          if (await isAgentLocked(workspaceId, workspaceDir, path.dirname(abs))) {
            throw new Error(`The target directory is locked [R] — toggle the lock in the file tree to allow writes.`);
          }
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, new_string, "utf8");
          return `Created ${file_path}`;
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Edit existing file
      const abs = await fs.realpath(path.resolve(workspaceDir, file_path)).catch(() => null);
      if (!abs || (!abs.startsWith(wsReal + path.sep) && abs !== wsReal))
        return "Error: path is outside the workspace";
      try {
        if (await isAgentLocked(workspaceId, workspaceDir, abs)) {
          throw new Error(`"${file_path}" is read-only [R] — ask the user to click the lock icon next to the file in the file tree to unlock it.`);
        }
        const content = await fs.readFile(abs, "utf8");
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
        await fs.writeFile(abs, updated, "utf8");
        return `Updated ${file_path}`;
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "file_edit",
      description: `Edit a file by replacing an exact string. Use this instead of sed or awk.

- You MUST call file_read first. Editing a file you haven't read will produce wrong results.
- If file_read shows [R] for the file, DO NOT call this tool — tell the user the file is locked instead.
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

// Agent tool: list shared drives, or browse a drive's contents.
// No drive_name -> lists the drives connected to this workspace (name + description).
// With drive_name [+ path] -> lists that directory's entries host-side (drives are never
// mounted into a container). Directories are marked with a trailing slash.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import { getDrivesForWorkspace, formatDriveLine } from "@/lib/drives/store";
import { resolveDrivePath } from "../driveAccess";
import { toolError } from "../toolUtils";

const schema = z.object({
  drive_name: z
    .string()
    .optional()
    .describe("Drive to browse, by name or id. Omit to list the drives connected to this workspace."),
  path: z.string().optional().describe("Directory path within the drive. Omit for the drive root."),
});

export class DriveLsTool extends StructuredTool<typeof schema> {
  name = "drive_ls";
  description = `List shared drives or browse a drive's contents.
Call with no arguments to list the drives connected to this workspace.
Call with drive_name (and optional path) to list a directory inside that drive.`;
  schema = schema;

  constructor(private workspaceId: string) {
    super();
  }

  protected async _call({ drive_name, path: dirPath }: z.infer<typeof schema>): Promise<string> {
    if (!drive_name) {
      const drives = getDrivesForWorkspace(this.workspaceId);
      if (!drives.length) return "No drives connected to this workspace.";
      return drives.map(formatDriveLine).join("\n");
    }

    const resolved = resolveDrivePath(this.workspaceId, drive_name, dirPath);
    if (typeof resolved === "string") return resolved;

    try {
      const entries = await fs.readdir(resolved.absPath, { withFileTypes: true });
      if (!entries.length) return "(empty directory)";
      return entries
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return `Error: path not found in drive "${drive_name}"`;
      if (e.code === "ENOTDIR") return `Error: "${dirPath}" is a file, not a directory`;
      return toolError(e);
    }
  }
}

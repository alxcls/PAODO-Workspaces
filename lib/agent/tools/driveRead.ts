// Agent tool: read a file from a shared drive directly into the agent's context (no local copy).
// Reads host-side (drives are never mounted into a container). For a working copy you can edit
// with your normal file tools, use drive_download instead. Text files only in v1.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import { resolveDrivePath } from "../driveAccess";

const schema = z.object({
  drive_name: z.string().describe("Drive to read from, by name or id"),
  path: z.string().describe("File path within the drive"),
});

export class DriveReadTool extends StructuredTool<typeof schema> {
  name = "drive_read";
  description = `Read a file's text content from a shared drive into your context.
Use this for a quick look. To get an editable copy in your workspace, use drive_download.`;
  schema = schema;

  constructor(private workspaceId: string) {
    super();
  }

  protected async _call({ drive_name, path: filePath }: z.infer<typeof schema>): Promise<string> {
    const resolved = resolveDrivePath(this.workspaceId, drive_name, filePath);
    if (typeof resolved === "string") return resolved;
    if (!resolved.relPath) return "Error: a file path within the drive is required";

    try {
      return await fs.readFile(resolved.absPath, "utf-8");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return `Error: file not found in drive "${drive_name}"`;
      if (e.code === "EISDIR") return `Error: "${filePath}" is a directory, not a file`;
      return `Error: ${e.message}`;
    }
  }
}

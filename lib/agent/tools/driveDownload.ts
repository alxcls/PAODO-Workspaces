// Agent tool: copy a file from a shared drive into the local workspace so you can work on it with
// your normal file tools. The drive file is read host-side; the workspace copy is written THROUGH
// the container (mkdir -p + tee) so it is owned by the in-container user and you can edit it freely.
// Lands at downloads/<drive-name>/<path>. Text files only in v1.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import { resolveDrivePath } from "../driveAccess";
import type { ExecRunner } from "../interfaces";

const schema = z.object({
  drive_name: z.string().describe("Drive to download from, by name or id"),
  path: z.string().describe("File path within the drive"),
});

export class DriveDownloadTool extends StructuredTool<typeof schema> {
  name = "drive_download";
  description = `Copy a file from a shared drive into your workspace at downloads/<drive-name>/<path>.
Use this when you need an editable local copy. For a quick read without a copy, use drive_read.`;
  schema = schema;

  constructor(private workspaceId: string, private runner: ExecRunner) {
    super();
  }

  protected async _call({ drive_name, path: filePath }: z.infer<typeof schema>): Promise<string> {
    const resolved = resolveDrivePath(this.workspaceId, drive_name, filePath);
    if (typeof resolved === "string") return resolved;
    if (!resolved.relPath) return "Error: a file path within the drive is required";

    let content: string;
    try {
      content = await fs.readFile(resolved.absPath, "utf-8");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return `Error: file not found in drive "${drive_name}"`;
      if (e.code === "EISDIR") return `Error: "${filePath}" is a directory, not a file`;
      return `Error: ${e.message}`;
    }

    const dest = path.posix.join("downloads", resolved.drive.name, resolved.relPath);
    const destDir = path.posix.dirname(dest);
    try {
      const mkdir = await this.runner.exec(["mkdir", "-p", `/workspace/${destDir}`]);
      if (mkdir.code !== 0) return `Error: could not create directory: ${mkdir.stderr}`;
      const write = await this.runner.exec(["tee", `/workspace/${dest}`], { stdin: content });
      if (write.code !== 0) return `Error: ${write.stderr || "write failed"}`;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    return `Downloaded ${filePath} from drive "${drive_name}" to ${dest} (${content.length} chars)`;
  }
}

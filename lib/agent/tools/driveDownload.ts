// Agent tool: copy a file from a shared drive into the local workspace so you can work on it with
// your normal file tools. The drive file is read host-side as raw bytes; the workspace copy is
// written THROUGH the container (mkdir -p, then base64-decode into the dest) so it is owned by the
// in-container user and you can edit it freely. The container transport (exec stdin) is text-only,
// so bytes ride in base64-encoded and are decoded container-side — this keeps binary files (SQLite,
// images, archives) intact. Lands at downloads/<drive-name>/<path>.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import { resolveDrivePath } from "../driveAccess";
import { toolError } from "../toolUtils";
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

    let content: Buffer;
    try {
      content = await fs.readFile(resolved.absPath);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return `Error: file not found in drive "${drive_name}"`;
      if (e.code === "EISDIR") return `Error: "${filePath}" is a directory, not a file`;
      return toolError(e);
    }

    const dest = path.posix.join("downloads", resolved.drive.name, resolved.relPath);
    const destDir = path.posix.dirname(dest);
    try {
      const mkdir = await this.runner.exec(["mkdir", "-p", `/workspace/${destDir}`]);
      if (mkdir.code !== 0) return `Error: could not create directory: ${mkdir.stderr}`;
      // exec stdin is text-only, so the bytes ride in base64 and are decoded container-side. The
      // dest path is passed as a positional arg ($1), not interpolated into the script, so an odd
      // drive or file name cannot inject shell.
      const write = await this.runner.exec(
        ["sh", "-c", 'base64 -d > "$1"', "sh", `/workspace/${dest}`],
        { stdin: content.toString("base64") },
      );
      if (write.code !== 0) return `Error: ${write.stderr || "write failed"}`;
    } catch (err: unknown) {
      return toolError(err);
    }
    return `Downloaded ${filePath} from drive "${drive_name}" to ${dest} (${content.length} bytes)`;
  }
}

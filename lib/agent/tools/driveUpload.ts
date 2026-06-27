// Agent tool: copy a file from the local workspace into a shared drive so other agents can use it.
// The workspace file is read host-side and written into the drive host-side (drives are never
// mounted into a container). A drive is a plain live filesystem: one file per path, newest wins.
// Uploading over an existing path overwrites it and the result SIGNALS the overwrite, so a clobber
// is never silent. Text files only in v1.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import { normalizeRelpath } from "../pathUtils";
import { resolveDrivePath } from "../driveAccess";

const schema = z.object({
  source_path: z.string().describe("Path of the workspace file to upload (relative to workspace root)"),
  drive_name: z.string().describe("Drive to upload into, by name or id"),
  dest_path: z.string().optional().describe("Destination path within the drive. Defaults to the source file name at the drive root."),
});

export class DriveUploadTool extends StructuredTool<typeof schema> {
  name = "drive_upload";
  description = `Copy a file from your workspace into a shared drive so other agents can use it.
If a file already exists at the destination it is overwritten (newest wins) and the result says so.`;
  schema = schema;

  constructor(private workspaceId: string, private workspaceDir: string) {
    super();
  }

  protected async _call({ source_path, drive_name, dest_path }: z.infer<typeof schema>): Promise<string> {
    const srcRel = normalizeRelpath(source_path);
    if (srcRel === null) return "Error: source path is outside the workspace";

    const dest = dest_path?.trim() || path.posix.basename(srcRel);
    const resolved = resolveDrivePath(this.workspaceId, drive_name, dest);
    if (typeof resolved === "string") return resolved;
    if (!resolved.relPath) return "Error: a destination file path within the drive is required";

    let content: Buffer;
    try {
      content = await fs.readFile(path.join(this.workspaceDir, srcRel));
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return `Error: workspace file not found: ${source_path}`;
      if (e.code === "EISDIR") return `Error: "${source_path}" is a directory, not a file`;
      return `Error: ${e.message}`;
    }

    const existed = await fs
      .access(resolved.absPath)
      .then(() => true)
      .catch(() => false);

    try {
      await fs.mkdir(path.dirname(resolved.absPath), { recursive: true });
      await fs.writeFile(resolved.absPath, content);
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    const where = `${resolved.relPath} in drive "${drive_name}"`;
    return existed
      ? `Uploaded ${where} — overwrote existing file (${content.length} bytes)`
      : `Uploaded ${where} (${content.length} bytes)`;
  }
}

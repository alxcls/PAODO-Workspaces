/**
 * Agent tool: copy a file or a whole folder from a shared drive into the local workspace so you can
 * work on it with your normal file tools. Symmetric with drive_upload — drive bytes are read host-side
 * and written host-side straight into the workspace tree at downloads/<drive-name>/<path> with plain
 * fs, no container in the path. The app process and the in-container agent share uid 1000 on the same
 * workspace volume, so a host-side write lands owned by the agent with no chown, exactly as the browser
 * upload routes already rely on. Writing raw bytes keeps binary files (SQLite, images, archives) intact.
 */

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import { resolveWorkspacePath } from "../pathUtils";
import {
  resolveDrivePath,
  readFileBounded,
  enumerateDriveFolder,
  formatFolderTransfer,
  compactError,
  type ResolvedDrivePath,
} from "../driveAccess";
import { toolError } from "../toolUtils";
import { MAX_DRIVE_TRANSFER_BYTES } from "@/lib/infra/limits";

const schema = z.object({
  drive_name: z.string().describe("Drive to download from, by name or id"),
  path: z.string().describe("File or folder path within the drive. A folder is downloaded recursively."),
});

export class DriveDownloadTool extends StructuredTool<typeof schema> {
  name = "drive_download";
  description = `Copy a file or a whole folder from a shared drive into your workspace at downloads/<drive-name>/<path>.
A folder is downloaded recursively, preserving its structure. Use this when you need an editable local copy. For a quick read of one file without a copy, use drive_read.`;
  schema = schema;

  constructor(
    private workspaceId: string,
    private workspaceDir: string,
  ) {
    super();
  }

  protected async _call({ drive_name, path: filePath }: z.infer<typeof schema>): Promise<string> {
    const resolved = resolveDrivePath(this.workspaceId, drive_name, filePath);
    if (typeof resolved === "string") return resolved;

    let stat;
    try {
      stat = await fs.stat(resolved.absPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return `Error: path not found in drive "${drive_name}"`;
      return toolError(err);
    }

    if (stat.isDirectory()) return this.downloadFolder(resolved);

    const put = await this.putFile(resolved.absPath, resolved.drive.name, resolved.relPath);
    if ("error" in put) return put.error;
    return `Downloaded ${filePath} from drive "${drive_name}" to ${put.dest} (${put.bytes} bytes)`;
  }

  private async downloadFolder(resolved: ResolvedDrivePath): Promise<string> {
    const files = await enumerateDriveFolder(resolved.absPath);
    if (!files.length) return `Error: "${resolved.relPath || "/"}" holds no files to download`;

    let moved = 0;
    let bytes = 0;
    const skipped: string[] = [];
    for (const rel of files) {
      const driveRel = resolved.relPath ? path.posix.join(resolved.relPath, rel) : rel;
      const put = await this.putFile(path.join(resolved.absPath, rel), resolved.drive.name, driveRel);
      if ("error" in put) {
        skipped.push(`${rel} (${compactError(put.error)})`);
        continue;
      }
      moved += 1;
      bytes += put.bytes;
    }
    const target = path.posix.join("downloads", resolved.drive.name, resolved.relPath);
    return formatFolderTransfer("Downloaded", moved, bytes, target, skipped);
  }

  private async putFile(
    srcAbs: string,
    driveName: string,
    relPath: string,
  ): Promise<{ bytes: number; dest: string } | { error: string }> {
    const content = await readFileBounded(srcAbs, MAX_DRIVE_TRANSFER_BYTES, {
      missing: `Error: file not found in drive "${driveName}"`,
      isDirectory: `Error: "${relPath}" is a directory, not a file`,
      advice: `Split it on the drive first (e.g. split -b 40m), or work with it where it is rather than copying it in.`,
    });
    if (typeof content === "string") return { error: content };

    const dest = path.posix.join("downloads", driveName, relPath);
    // Realpath-contained just as file_write is: a drive whose name or a file whose path carried a
    // traversal segment must not land the write outside the workspace tree.
    const absDest = await resolveWorkspacePath(this.workspaceDir, dest);
    if (absDest === null) return { error: `Error: download destination escapes the workspace: ${dest}` };

    try {
      await fs.mkdir(path.dirname(absDest), { recursive: true });
      await fs.writeFile(absDest, content);
    } catch (err: unknown) {
      return { error: toolError(err) };
    }
    return { bytes: content.length, dest };
  }
}

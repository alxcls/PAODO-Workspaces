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
import { MAX_DRIVE_LISTING_ENTRIES } from "@/lib/infra/limits";

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
      // opendir + stop at the ceiling, rather than readdir. readdir materializes a Dirent for every
      // name in the directory before this code sees any of them, so a drive holding a million files
      // is an unbounded allocation in the app's heap that no container limit sits above — drives are
      // read host-side. Streaming the entries means the ceiling bounds the scan, not just the output.
      const entries: { name: string; isDirectory: boolean }[] = [];
      let truncated = false;
      for await (const entry of await fs.opendir(resolved.absPath)) {
        if (entries.length === MAX_DRIVE_LISTING_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({ name: entry.name, isDirectory: entry.isDirectory() });
      }
      if (!entries.length) return "(empty directory)";

      const lines = entries
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map((e) => (e.isDirectory ? `${e.name}/` : e.name));

      // Say that the set is partial AND that it is arbitrary: the sort runs after the cut, so these
      // are the first entries the filesystem happened to return, not the alphabetically first ones.
      // An agent told only "truncated" will reasonably assume it saw everything up to some letter.
      if (truncated) {
        lines.push(
          `[listing truncated at ${MAX_DRIVE_LISTING_ENTRIES} entries — this directory holds more. ` +
            `These are the first ${MAX_DRIVE_LISTING_ENTRIES} the filesystem returned, in no particular order. ` +
            `Narrow the path to see the rest.]`,
        );
      }
      return lines.join("\n");
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return `Error: path not found in drive "${drive_name}"`;
      if (e.code === "ENOTDIR") return `Error: "${dirPath}" is a file, not a directory`;
      return toolError(e);
    }
  }
}

// Agent tool: read a file from a shared drive directly into the agent's context (no local copy).
// Reads host-side (drives are never mounted into a container). For a working copy you can edit
// with your normal file tools, use drive_download instead. This tool only returns text — binary
// files (SQLite, images, archives) can't go into the LLM context as text, so it detects them and
// points you to drive_download rather than returning mojibake.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveDrivePath, readFileBounded } from "../driveAccess";
import { MAX_FILE_READ_BYTES } from "@/lib/infra/limits";

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

    // The ceiling is the same one file_read uses, because this is the same act: bytes into the
    // context. It refuses rather than truncating — this tool has no offset/limit to resume from, so
    // a truncated read would leave nowhere to go, while drive_download does.
    const buf = await readFileBounded(resolved.absPath, MAX_FILE_READ_BYTES, {
      missing: `Error: file not found in drive "${drive_name}"`,
      isDirectory: `Error: "${filePath}" is a directory, not a file`,
      advice: `Use drive_download to copy it into your workspace, then file_read with offset/limit to page through it.`,
    });
    if (typeof buf === "string") return buf;

    if (buf.subarray(0, 8000).includes(0)) {
      return `Error: "${filePath}" looks like a binary file and can't be read as text. Use drive_download to copy it into your workspace instead.`;
    }
    return buf.toString("utf-8");
  }
}

// Agent tool that reads a workspace file, returning its content with 1-based line numbers
// (cat -n format). Reads the whole file via `cat`, or a line range via `sed -n` when offset/
// limit are given (offset is 0-based, so it maps to sed line offset+1). Paths are confined to
// the workspace root. The agent must read a file with this tool before editing it via file_edit.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { normalizeRelpath } from "../pathUtils";
import { toolError } from "../toolUtils";
import type { ExecRunner } from "../interfaces";

const schema = z.object({
  file_path: z.string().describe("File path relative to workspace root"),
  offset: z.number().int().min(0).optional().describe("Line index to start from (0-based). Omit to start from the beginning."),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to return. Omit to read to end of file."),
});

export class FileReadTool extends StructuredTool<typeof schema> {
  name = "file_read";
  readonly skipResultCap = true;
  description = `Read a file from the workspace. Returns content with line numbers (cat -n format).
Use this instead of cat, head, or tail.

- file_path is relative to the workspace root.
- Use offset + limit to read only part of a large file (e.g. offset:49, limit:50 reads lines 50–99).
- You MUST read a file with this tool before editing it with file_edit.`;
  schema = schema;

  constructor(private runner: ExecRunner) {
    super();
  }

  protected async _call({ file_path, offset, limit }: z.infer<typeof schema>): Promise<string> {
    const relpath = normalizeRelpath(file_path);
    if (relpath === null) return "Error: path is outside the workspace";
    try {
      const header = `${file_path}\n`;

      if (offset === undefined && limit === undefined) {
        const r = await this.runner.exec(["cat", `/workspace/${relpath}`]);
        if (r.code !== 0) return `Error: ${r.stderr || "file not found or unreadable"}`;
        const lines = r.stdout.split("\n");
        return header + lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
      } else {
        const startLine = (offset ?? 0) + 1;
        const endLine = limit !== undefined ? (offset ?? 0) + limit : "$";
        const r = await this.runner.exec([
          "sed", "-n", `${startLine},${endLine}p`, `/workspace/${relpath}`,
        ]);
        if (r.code !== 0) return `Error: ${r.stderr || "file not found or unreadable"}`;
        const start = offset ?? 0;
        const lines = r.stdout.split("\n");
        return header + lines.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
      }
    } catch (err: unknown) {
      return toolError(err);
    }
  }
}

// Agent tool that reads a workspace file, returning its content with 1-based line numbers
// (cat -n format). Reads the whole file via `cat`, or a line range via `sed -n` when offset/
// limit are given (offset is 0-based, so it maps to sed line offset+1). Paths are confined to
// the workspace root. The agent must read a file with this tool before editing it via file_edit.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { normalizeRelpath } from "../pathUtils";
import { toolError } from "../toolUtils";
import type { ExecRunner } from "../interfaces";

// How much of a file one call may pull into the process. Enforced INSIDE the container by `head -c`,
// so an oversized file is never transferred at all — the alternative (read it all, then trim) is the
// bug, not the fix: a plain `cat` of a large file blew the heap here, and the split/map/join below
// multiplies whatever arrives by another three copies before anything gets a chance to trim it.
//
// This tool sets skipResultCap, deliberately, so that a legitimately large file still reads in one
// call. That makes this constant the only thing bounding it, hence a generous value rather than the
// 50k dispatch cap — and offset/limit remains the way to page past it.
const MAX_FILE_READ_BYTES = parseInt(process.env.MAX_FILE_READ_BYTES ?? "", 10) || 400_000;

const schema = z.object({
  file_path: z.string().describe("File path relative to workspace root"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Line index to start from (0-based). Omit to start from the beginning."),
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

  // Truncation has to name the way forward, not just report a stop — the agent already has the right
  // tool for this (offset/limit), and without the pointer it tends to retry the identical read.
  //
  // resumeOffset is the 0-based index of the LAST line shown, not the one after it: the byte ceiling
  // cuts mid-line, so that last line is a fragment and the agent has to re-read it to get its
  // remainder. Pointing past it would hand back a notice that exists to stop truncation being silent
  // while itself losing the tail of a line silently.
  private moreToRead(resumeOffset: number): string {
    return (
      `\n\n[file truncated at ${MAX_FILE_READ_BYTES} bytes — this is not the whole file]\n` +
      `Continue with file_read using offset: ${resumeOffset} (and a limit) to read on from here. ` +
      `That line is re-read because the cut landed in the middle of it.`
    );
  }

  protected async _call({ file_path, offset, limit }: z.infer<typeof schema>): Promise<string> {
    const relpath = normalizeRelpath(file_path);
    if (relpath === null) return "Error: path is outside the workspace";
    try {
      const header = `${file_path}\n`;

      if (offset === undefined && limit === undefined) {
        // `head -c` rather than `cat`: the ceiling is applied in the container, so an oversized file
        // never crosses into this process. One byte over the limit is requested purely so a file that
        // is exactly at the limit is not misreported as truncated.
        const r = await this.runner.exec(["head", "-c", String(MAX_FILE_READ_BYTES + 1), `/workspace/${relpath}`]);
        if (r.code !== 0) return `Error: ${r.stderr || "file not found or unreadable"}`;
        const truncated = Buffer.byteLength(r.stdout, "utf8") > MAX_FILE_READ_BYTES;
        const lines = r.stdout.split("\n");
        const numbered = header + lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
        return truncated ? numbered + this.moreToRead(lines.length - 1) : numbered;
      } else {
        const startLine = (offset ?? 0) + 1;
        const endLine = limit !== undefined ? (offset ?? 0) + limit : "$";
        const r = await this.runner.exec(["sed", "-n", `${startLine},${endLine}p`, `/workspace/${relpath}`]);
        if (r.code !== 0) return `Error: ${r.stderr || "file not found or unreadable"}`;
        const start = offset ?? 0;
        const lines = r.stdout.split("\n");
        const numbered = header + lines.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
        // A range can still be unbounded (limit omitted, or a huge limit over very long lines), in
        // which case the docker-client ceiling is what stopped it rather than a line count.
        return r.truncated ? numbered + this.moreToRead(start + lines.length - 1) : numbered;
      }
    } catch (err: unknown) {
      return toolError(err);
    }
  }
}

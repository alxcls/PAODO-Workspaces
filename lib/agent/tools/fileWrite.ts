import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import { normalizeRelpath } from "./pathUtils";
import type { ExecRunner } from "./interfaces";

const schema = z.object({
  file_path: z.string().describe("File path relative to workspace root"),
  content: z.string().describe("Full content to write to the file"),
});

export class FileWriteTool extends StructuredTool<typeof schema> {
  name = "file_write";
  description = `Write full content to a file, creating or overwriting it.
ALWAYS use this when the user asks you to "write", "create", or "save" a file — never output the content as a code block in text.
Use for creating new files or complete rewrites. For targeted edits to existing files, prefer file_edit.
If the file already exists and you need to preserve or merge its content, read it first with file_read. If you are replacing it wholesale or creating a new file, skip the read.`;
  schema = schema;

  constructor(private runner: ExecRunner) {
    super();
  }

  protected async _call({ file_path, content }: z.infer<typeof schema>): Promise<string> {
    const relpath = normalizeRelpath(file_path);
    if (relpath === null) return "Error: path is outside the workspace";
    try {
      const dirRelpath = path.posix.dirname(relpath);
      if (dirRelpath && dirRelpath !== ".") {
        const mkdirR = await this.runner.exec(["mkdir", "-p", `/workspace/${dirRelpath}`]);
        if (mkdirR.code !== 0) return `Error: could not create directory: ${mkdirR.stderr}`;
      }

      const writeR = await this.runner.exec(["tee", `/workspace/${relpath}`], { stdin: content });
      if (writeR.code !== 0) return `Error: ${writeR.stderr || "write failed"}`;

      return `Written ${file_path} (${content.length} chars)`;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

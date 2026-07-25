// Agent tool that edits a workspace file via exact string replacement (in-process, not sed/awk).
// Reads the file with `cat`, replaces old_string with new_string (first occurrence, or all when
// replace_all is set), then writes it back via `tee`. Fails if old_string is absent, or if it
// matches more than once without replace_all. An empty old_string is the create-file branch:
// it makes parent dirs (mkdir -p) and writes new_string as the full content. Confined to the
// workspace root. The agent is expected to file_read first so old_string matches exactly.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { normalizeRelpath, resolveWorkspacePath } from "../pathUtils";
import { toolError } from "../toolUtils";
import { writeContainerFile } from "./containerWrite";
import { checkFreeSpace } from "../../workspace/diskSpace";
import { RESERVED_FREE_BYTES } from "../../workspace/uploadLimits";
import type { ExecRunner } from "../interfaces";

const schema = z.object({
  file_path: z.string().describe("File path relative to workspace root"),
  old_string: z.string().describe("Exact text to replace (empty string to create a new file)"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of just the first (default false)"),
});

export class FileEditTool extends StructuredTool<typeof schema> {
  name = "file_edit";
  description = `Edit a file by replacing an exact string. Use this instead of sed or awk.

- You MUST call file_read first. Editing a file you haven't read will produce wrong results.
- old_string must match exactly — including whitespace, indentation, and newlines.
- Fails if old_string appears more than once. Add more surrounding lines for uniqueness, or set replace_all: true.
- Set old_string to "" to create a new file (new_string becomes the full content).`;
  schema = schema;

  constructor(
    private runner: ExecRunner,
    private workspaceDir: string,
  ) {
    super();
  }

  protected async _call({ file_path, old_string, new_string, replace_all }: z.infer<typeof schema>): Promise<string> {
    const relpath = normalizeRelpath(file_path);
    if (relpath === null) return "Error: path is outside the workspace";
    // Lexical check above catches "../"/absolute paths; this catches a symlink planted inside the
    // workspace that redirects relpath elsewhere on disk (see lib/workspace/pathContainment.ts).
    // Covers both branches below since relpath is resolved once, up front.
    if ((await resolveWorkspacePath(this.workspaceDir, relpath)) === null) {
      return "Error: path is outside the workspace";
    }

    if (old_string === "") {
      // Create new file branch — same mkdir + write as file_write.
      const err = await writeContainerFile(this.runner, this.workspaceDir, relpath, new_string);
      return err ?? `Created ${file_path}`;
    }

    // Edit existing file branch
    try {
      // stdout must NOT be trimmed (preserves trailing newlines for correct string matching)
      const readR = await this.runner.exec(["cat", `/workspace/${relpath}`]);
      if (readR.code !== 0) return `Error: ${readR.stderr || "file not found or unreadable"}`;

      const content = readR.stdout;
      if (!content.includes(old_string)) {
        return `Error: old_string not found in ${file_path}. Ensure exact match including whitespace and indentation.`;
      }
      const count = content.split(old_string).length - 1;
      if (count > 1 && !replace_all) {
        return `Error: old_string appears ${count} times. Add more surrounding lines to make it unique, or set replace_all: true.`;
      }
      const updated = replace_all
        ? content.replaceAll(old_string, new_string)
        : content.replace(old_string, new_string);

      const space = await checkFreeSpace(this.workspaceDir, Buffer.byteLength(updated), RESERVED_FREE_BYTES);
      if (!space.ok) return "Error: not enough free disk space to write this file.";

      const writeR = await this.runner.exec(["tee", `/workspace/${relpath}`], { stdin: updated });
      if (writeR.code !== 0) return `Error: ${writeR.stderr || "write failed"}`;
      return `Updated ${file_path}`;
    } catch (err: unknown) {
      return toolError(err);
    }
  }
}

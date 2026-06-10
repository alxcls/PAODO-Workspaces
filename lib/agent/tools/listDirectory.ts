import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { normalizeDirPath } from "./pathUtils";
import type { ExecRunner } from "./interfaces";

const schema = z.object({
  dir_path: z.string().optional().describe("Directory path relative to workspace root. Omit or use '.' for the workspace root."),
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export class ListDirectoryTool extends StructuredTool<typeof schema> {
  name = "list_directory";
  description = `List the contents of a directory in the workspace. Returns entries sorted with directories first.
Each line: type (d=directory, -=file), name, and file size.
Use this instead of ls. For recursive or pattern-based search use glob instead.`;
  schema = schema;

  constructor(private runner: ExecRunner) {
    super();
  }

  protected async _call({ dir_path }: z.infer<typeof schema>): Promise<string> {
    const relDir = normalizeDirPath(dir_path ?? ".");
    if (relDir === null) return "Error: path is outside the workspace";
    try {
      const containerDir = relDir === "." ? "/workspace" : `/workspace/${relDir}`;

      const r = await this.runner.exec([
        "find", containerDir,
        "-maxdepth", "1",
        "-mindepth", "1",
        "-printf", "%y\t%s\t%f\n",
      ]);
      if (r.code !== 0) return `Error: ${r.stderr || "directory not found or unreadable"}`;

      const rawLines = r.stdout.split("\n").filter(Boolean);
      if (rawLines.length === 0) return "(empty directory)";

      interface Entry { type: string; sizeBytes: number; name: string }
      const entries: Entry[] = rawLines.map((line) => {
        const tab1 = line.indexOf("\t");
        const tab2 = line.indexOf("\t", tab1 + 1);
        return {
          type: line.slice(0, tab1),
          sizeBytes: parseInt(line.slice(tab1 + 1, tab2), 10) || 0,
          name: line.slice(tab2 + 1),
        };
      });

      entries.sort((a, b) => {
        const aIsDir = a.type === "d";
        const bIsDir = b.type === "d";
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const lines = entries.map((entry) => {
        const isDir = entry.type === "d";
        const typeChar = isDir ? "d" : "-";
        const suffix = isDir ? "/" : "";
        const size = isDir ? "" : `  ${formatSize(entry.sizeBytes)}`;
        return `${typeChar}  ${entry.name}${suffix}${size}`;
      });

      return lines.join("\n");
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

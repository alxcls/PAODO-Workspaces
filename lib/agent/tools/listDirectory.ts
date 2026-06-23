// Agent tool that lists the immediate contents of one workspace directory (non-recursive).
// Runs `find -maxdepth 2` inside the container (depth 2 only to count each subdirectory's
// children), then sorts entries directories-first and alphabetically. Each line shows a type
// marker (d=directory, -=file), the name (dirs get a trailing /), a line count for files (via
// `wc -l`) or child count for directories, and the modified time as a relative age. Paths are
// confined to the workspace root. For recursive or pattern-based search use the glob tool instead.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { normalizeDirPath } from "../pathUtils";
import type { ExecRunner } from "../interfaces";

const schema = z.object({
  dir_path: z.string().optional().describe("Directory path relative to workspace root. Omit or use '.' for the workspace root."),
});

function formatLines(lines: number): string {
  return lines === 1 ? "1 line" : `${lines} lines`;
}

function formatItems(n: number): string {
  return n === 1 ? "1 item" : `${n} items`;
}

function formatAge(epochSeconds: number, nowMs: number): string {
  const sec = Math.max(0, Math.floor(nowMs / 1000 - epochSeconds));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

export class ListDirectoryTool extends StructuredTool<typeof schema> {
  name = "list_directory";
  description = `List the contents of a directory in the workspace. Returns entries sorted with directories first.
Each line: type (d=directory, -=file), name, line count (files) or child count (directories), and modified time.
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

      // Depth 2 (not 1) so each immediate subdirectory's own children are listed
      // and can be tallied into a child count. Fields: depth, type, mtime(epoch),
      // parent dir, name. Only depth-1 rows become entries; depth-2 rows are counted.
      const r = await this.runner.exec([
        "find", containerDir,
        "-mindepth", "1",
        "-maxdepth", "2",
        "-printf", "%d\t%y\t%T@\t%h\t%f\n",
      ]);
      if (r.code !== 0) return `Error: ${r.stderr || "directory not found or unreadable"}`;

      interface Entry { type: string; name: string; mtime: number; lineCount?: number; childCount?: number }
      const entries: Entry[] = [];
      const childCounts = new Map<string, number>();
      for (const line of r.stdout.split("\n").filter(Boolean)) {
        const t1 = line.indexOf("\t");
        const t2 = line.indexOf("\t", t1 + 1);
        const t3 = line.indexOf("\t", t2 + 1);
        const t4 = line.indexOf("\t", t3 + 1);
        const depth = line.slice(0, t1);
        const parent = line.slice(t3 + 1, t4);
        if (depth === "1") {
          entries.push({
            type: line.slice(t1 + 1, t2),
            mtime: parseFloat(line.slice(t2 + 1, t3)) || 0,
            name: line.slice(t4 + 1),
          });
        } else {
          childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
        }
      }
      if (entries.length === 0) return "(empty directory)";

      entries.sort((a, b) => {
        const aIsDir = a.type === "d";
        const bIsDir = b.type === "d";
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (const e of entries) {
        if (e.type === "d") e.childCount = childCounts.get(`${containerDir}/${e.name}`) ?? 0;
      }

      // Count lines for regular files in a single `wc -l` pass. wc prints one
      // line per input file as "<count> <path>" (with a trailing "<total> total"
      // line when there are 2+ files); we map counts back to entries by path.
      const fileEntries = entries.filter((e) => e.type === "f");
      if (fileEntries.length > 0) {
        const paths = fileEntries.map((e) => `${containerDir}/${e.name}`);
        const wc = await this.runner.exec(["wc", "-l", ...paths]);
        const countByPath = new Map<string, number>();
        for (const line of wc.stdout.split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(.*)$/);
          if (m) countByPath.set(m[2], parseInt(m[1], 10));
        }
        for (const e of fileEntries) {
          e.lineCount = countByPath.get(`${containerDir}/${e.name}`);
        }
      }

      // Pre-render the name and detail columns, then pad each to its widest value
      // so the count and time columns line up vertically.
      const now = Date.now();
      const rows = entries.map((entry) => {
        const isDir = entry.type === "d";
        let detail = "";
        if (isDir) detail = formatItems(entry.childCount ?? 0);
        else if (entry.lineCount !== undefined) detail = formatLines(entry.lineCount);
        return {
          type: isDir ? "d" : "-",
          name: `${entry.name}${isDir ? "/" : ""}`,
          detail,
          age: formatAge(entry.mtime, now),
        };
      });
      const nameWidth = Math.max(...rows.map((r) => r.name.length));
      const detailWidth = Math.max(...rows.map((r) => r.detail.length));
      const lines = rows.map(
        (r) => `${r.type}  ${r.name.padEnd(nameWidth)}  ${r.detail.padEnd(detailWidth)}  ${r.age}`,
      );

      // Lead with a newline so the first row starts at column 0 rather than being
      // appended to the tool-call label, which would offset it from the rest.
      return `\n${lines.join("\n")}`;
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// Agent tool that finds files in the workspace matching a glob pattern.
// Supports *, ?, and ** segments. Dot-files and dot-directories are excluded automatically.
// Returns paths relative to the workspace root, sorted alphabetically.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { toolError } from "../toolUtils";
import type { ExecRunner } from "../interfaces";

const schema = z.object({
  pattern: z.string().describe("Glob pattern relative to workspace root. Supports * ? and **."),
});

function segmentToRegex(segment: string): RegExp {
  const escaped = segment.replace(/\./g, "\\.").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp("^" + escaped + "$");
}

function matchParts(patParts: string[], pathParts: string[]): boolean {
  if (patParts.length === 0) return pathParts.length === 0;
  const [seg, ...restPat] = patParts;

  if (seg === "**") {
    for (let i = 0; i <= pathParts.length; i++) {
      if (matchParts(restPat, pathParts.slice(i))) return true;
    }
    return false;
  }

  if (pathParts.length === 0) return false;
  const [part, ...restPath] = pathParts;
  return segmentToRegex(seg).test(part) && matchParts(restPat, restPath);
}

function matchGlob(pattern: string, relpath: string): boolean {
  return matchParts(pattern.split("/"), relpath.split("/"));
}

export class GlobTool extends StructuredTool<typeof schema> {
  name = "glob";
  description = `Find files in the workspace matching a glob pattern. Returns paths relative to the workspace root.
Use this instead of find or ls when searching by name or extension.

Examples:
  "**/*.ts"         — all TypeScript files recursively
  "src/**/*.test.*" — all test files under src/
  "*.json"          — JSON files at the workspace root
  "lib/**"          — everything under lib/

Dot-files and dot-directories are excluded automatically.`;
  schema = schema;

  constructor(private runner: ExecRunner) {
    super();
  }

  protected async _call({ pattern }: z.infer<typeof schema>): Promise<string> {
    try {
      if (pattern.startsWith("/")) {
        throw new Error("absolute paths are not allowed; use paths relative to the workspace root");
      }

      const r = await this.runner.exec([
        "find",
        "/workspace",
        "-not",
        "-path",
        "*/.*",
        "-mindepth",
        "1",
        "-printf",
        "%y\t%P\n",
      ]);
      if (r.code !== 0) return `Error: ${r.stderr || "glob search failed"}`;

      const matched = r.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          return line.slice(tab + 1);
        })
        .filter((relpath) => matchGlob(pattern, relpath))
        .sort();

      if (matched.length === 0) return "No files matched.";

      return matched.join("\n");
    } catch (err: unknown) {
      return toolError(err);
    }
  }
}

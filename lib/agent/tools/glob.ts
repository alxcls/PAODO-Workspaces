// Agent tool that finds files in the workspace matching a glob pattern.
// Supports *, ?, and ** segments. Dot-files and dot-directories are excluded automatically.
// Returns paths relative to the workspace root, sorted alphabetically.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { isAgentLocked } from "@/lib/infra/permissionStore";

async function globMatch(pattern: string, workspaceDir: string): Promise<string[]> {
  if (pattern.startsWith("/")) throw new Error("absolute paths are not allowed; use paths relative to the workspace root");
  const parts = pattern.split("/");
  const results: string[] = [];

  async function walk(dir: string, remainingParts: string[]): Promise<void> {
    const [segment, ...rest] = remainingParts;

    if (segment === "**") {
      // Match zero levels (treat remaining as sibling match)
      if (rest.length > 0) await walk(dir, rest);
      // Match one or more levels deep
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, remainingParts); // recurse with ** still active
          if (rest.length > 0) await walk(full, rest);
        } else if (rest.length > 0) {
          await walk(full, rest);
        }
      }
      return;
    }

    // Convert glob segment to regex
    const segmentRegex = new RegExp(
      "^" + segment.replace(/\./g, "\\.").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$"
    );

    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!segmentRegex.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (rest.length === 0) {
        results.push(full);
      } else if (entry.isDirectory()) {
        await walk(full, rest);
      }
    }
  }

  await walk(workspaceDir, parts);
  return results
    .map((p) => path.relative(workspaceDir, p))
    .filter((p) => !p.startsWith(".."))
    .sort();
}

export function buildGlobTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ pattern }) => {
      try {
        const matches = await globMatch(pattern, workspaceDir);
        if (matches.length === 0) return "No files matched.";
        const lines = await Promise.all(
          matches.map(async (rel) => {
            const abs = path.join(workspaceDir, rel);
            const perm = (await isAgentLocked(workspaceId, workspaceDir, abs)) ? " [R]" : " [RW]";
            return `${rel}${perm}`;
          })
        );
        return lines.join("\n");
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "glob",
      description: `Find files in the workspace matching a glob pattern. Returns paths relative to the workspace root.
Use this instead of find or ls when searching by name or extension.

Examples:
  "**/*.ts"         — all TypeScript files recursively
  "src/**/*.test.*" — all test files under src/
  "*.json"          — JSON files at the workspace root
  "lib/**"          — everything under lib/

Dot-files and dot-directories are excluded automatically.`,
      schema: z.object({
        pattern: z.string().describe("Glob pattern relative to workspace root. Supports * ? and **."),
      }),
    }
  );
}

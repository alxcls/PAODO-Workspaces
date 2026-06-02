// Agent tool that finds files in the workspace matching a glob pattern.
// Supports *, ?, and ** segments. Dot-files and dot-directories are excluded automatically.
// Returns paths relative to the workspace root, sorted alphabetically.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readPermissionSnapshot } from "@/lib/infra/permissionStore";
import { listSecured } from "@/lib/infra/securedScriptStore";
import { listHidden } from "@/lib/infra/hiddenStore";
import { dockerExec } from "@/lib/infra/containerManager";
import { permissionTags, isCovered } from "./tags";

// Convert a single glob segment (no path separators) to a regex.
function segmentToRegex(segment: string): RegExp {
  const escaped = segment
    .replace(/\./g, "\\.")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp("^" + escaped + "$");
}

// Match a POSIX relpath against a glob pattern using recursive segment matching.
function matchParts(patParts: string[], pathParts: string[]): boolean {
  if (patParts.length === 0) return pathParts.length === 0;
  const [seg, ...restPat] = patParts;

  if (seg === "**") {
    // ** matches zero or more path segments
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

// Pure check against a pre-fetched permission snapshot.
function isLockedFromSnapshot(
  snapshot: { globalLock: boolean; locked: string[] },
  relPath: string,
): boolean {
  if (snapshot.globalLock) return true;
  const parts = relPath.split("/");
  for (let i = 1; i <= parts.length; i++) {
    if (snapshot.locked.includes(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

export function buildGlobTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ pattern }) => {
      try {
        if (pattern.startsWith("/")) {
          throw new Error("absolute paths are not allowed; use paths relative to the workspace root");
        }

        // Single find call: all non-dotfile entries recursively.
        // -not -path "*/.*" excludes dotfiles and dotdirectories at any depth.
        // %y = type char (d/f/l/…), %P = path relative to the search root (no leading slash).
        const r = await dockerExec(workspaceId, workspaceDir, [
          "find", "/workspace",
          "-not", "-path", "*/.*",
          "-mindepth", "1",
          "-printf", "%y\t%P\n",
        ]);
        if (r.code !== 0) return `Error: ${r.stderr || "glob search failed"}`;

        // Parse into a flat list and filter by glob pattern
        const matched = r.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const tab = line.indexOf("\t");
            return line.slice(tab + 1); // relpath only; type not needed for matching
          })
          .filter((relpath) => matchGlob(pattern, relpath))
          .sort();

        if (matched.length === 0) return "No files matched.";

        // One disk read for all lock checks
        const snapshot = await readPermissionSnapshot(workspaceId);
        const securedPaths = listSecured(workspaceId);
        const hiddenPaths = listHidden(workspaceId);

        return matched
          .map((rel) => {
            const tags = permissionTags({
              locked: isLockedFromSnapshot(snapshot, rel),
              secured: isCovered(rel, securedPaths),
              hidden: isCovered(rel, hiddenPaths),
            });
            return `${rel} ${tags}`;
          })
          .join("\n");
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

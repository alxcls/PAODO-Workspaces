// Agent tool that lists the contents of a workspace directory.
// Uses a single docker exec find call, then resolves permissions via a batched snapshot.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import { readPermissionSnapshot } from "@/lib/infra/permissionStore";
import { listSecured } from "@/lib/infra/securedScriptStore";
import { listHidden } from "@/lib/infra/hiddenStore";
import { dockerExec } from "@/lib/infra/containerManager";
import { permissionTags, isCovered } from "./tags";

function normalizeRelpath(dirPath: string): string | null {
  if (!dirPath || dirPath === ".") return ".";
  const normalized = path.posix.normalize(dirPath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
  return normalized;
}

// Pure check against a pre-fetched permission snapshot — avoids N disk reads for N entries.
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function buildListDirectoryTool(workspaceId: string, workspaceDir: string) {
  return tool(
    async ({ dir_path }) => {
      const relDir = normalizeRelpath(dir_path ?? ".");
      if (relDir === null) return "Error: path is outside the workspace";
      try {
        const containerDir = relDir === "." ? "/workspace" : `/workspace/${relDir}`;

        // Single find call: type (%y), size in bytes (%s), filename (%f) for each direct child
        const r = await dockerExec(workspaceId, workspaceDir, [
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

        // Dirs first, then alphabetical within each group
        entries.sort((a, b) => {
          const aIsDir = a.type === "d";
          const bIsDir = b.type === "d";
          if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        // One disk read for all lock checks
        const snapshot = await readPermissionSnapshot(workspaceId);
        const securedPaths = listSecured(workspaceId);
        const hiddenPaths = listHidden(workspaceId);

        const lines = entries.map((entry) => {
          const isDir = entry.type === "d";
          const typeChar = isDir ? "d" : "-";
          const suffix = isDir ? "/" : "";
          const size = isDir ? "" : `  ${formatSize(entry.sizeBytes)}`;
          const entryRelPath = relDir === "." ? entry.name : `${relDir}/${entry.name}`;
          const tags = permissionTags({
            locked: isLockedFromSnapshot(snapshot, entryRelPath),
            secured: isCovered(entryRelPath, securedPaths),
            hidden: isCovered(entryRelPath, hiddenPaths),
          });
          return `${typeChar}  ${entry.name}${suffix}${size} ${tags}`;
        });

        return lines.join("\n");
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "list_directory",
      description: `List the contents of a directory in the workspace. Returns entries sorted with directories first.
Each line: type (d=directory, -=file), name, and file size.
Use this instead of ls. For recursive or pattern-based search use glob instead.`,
      schema: z.object({
        dir_path: z.string().optional().describe("Directory path relative to workspace root. Omit or use '.' for the workspace root."),
      }),
    }
  );
}

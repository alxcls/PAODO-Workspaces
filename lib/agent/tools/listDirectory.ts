// Agent tool that lists the contents of a workspace directory.
// Uses a single docker exec find call, then resolves permissions via a batched snapshot.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import { readPermissionSnapshot, isKeyedFromSnapshot } from "@/lib/infra/permissionStore";
import { dockerExec } from "@/lib/infra/containerManager";

function normalizeRelpath(dirPath: string): string | null {
  if (!dirPath || dirPath === ".") return ".";
  const normalized = path.posix.normalize(dirPath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
  return normalized;
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

        // Single find call per direct child.
        // Fields: type (%y), size (%s), symbolic mode (%M, e.g. -rw-rw-r--),
        //         owner name (%U), group name (%G), filename (%f).
        // listDirectory runs without asAgent so it can stat all files regardless of visibility.
        const r = await dockerExec(workspaceId, workspaceDir, [
          "find", containerDir,
          "-maxdepth", "1",
          "-mindepth", "1",
          "-printf", "%y\t%s\t%M\t%U\t%G\t%f\n",
        ]);
        if (r.code !== 0) return `Error: ${r.stderr || "directory not found or unreadable"}`;

        const rawLines = r.stdout.split("\n").filter(Boolean);
        if (rawLines.length === 0) return "(empty directory)";

        interface Entry { type: string; sizeBytes: number; mode: string; owner: string; group: string; name: string }
        const entries: Entry[] = rawLines.map((line) => {
          const parts = line.split("\t");
          return {
            type: parts[0],
            sizeBytes: parseInt(parts[1], 10) || 0,
            mode: parts[2],   // e.g. -rw-rw-r--
            owner: parts[3],  // e.g. agent, appuser, privd
            group: parts[4],  // e.g. access, agentgroup
            name: parts[5],
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

        const lines = entries.map((entry) => {
          const isDir = entry.type === "d";
          const suffix = isDir ? "/" : "";
          const size = isDir ? "       " : `  ${formatSize(entry.sizeBytes).padEnd(7)}`;
          const entryRelPath = relDir === "." ? entry.name : `${relDir}/${entry.name}`;
          // Only [keyed] is appended — Eye and Lock are already visible in the mode bits and owner name.
          const tagLabel = isKeyedFromSnapshot(snapshot, entryRelPath) ? "  [keyed]" : "";
          // e.g.: -  .env         2.3KB    -rw-rw---- appuser:access   [eye-off]
          return `${entry.mode}  ${entry.owner}:${entry.group}  ${entry.name}${suffix}${size}${tagLabel}`;
        });

        return lines.join("\n");
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "list_directory",
      description: `List the contents of a directory in the workspace. Returns entries sorted with directories first.
Each line shows Linux mode bits, owner:group, name, and size — exactly like ls -l.
You run as uid 999 (agent). If the owner column shows "agent", use the OWNER bits (first 3 after the leading type char); otherwise you are "other" — use the OTHER bits (last 3).
  rw-rw-r--  agent:access  → Normal — you can read and write
  -w-rw--w-  agent:access  → Eye-off — owner=-w-, you can write and delete, but not read (kernel will deny reads)
  rw-r--r--  privd:access  → Locked — other=r, you can read but not write
  rw-r-----  privd:access  → Eye-off+Lock — other=0, you cannot read or write
[keyed] is appended for scripts that run as privd (uid 998) via server dispatch — they can write locked files.
Use this instead of ls. For recursive or pattern-based search use glob instead.`,
      schema: z.object({
        dir_path: z.string().optional().describe("Directory path relative to workspace root. Omit or use '.' for the workspace root."),
      }),
    }
  );
}

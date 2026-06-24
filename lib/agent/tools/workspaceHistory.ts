// Agent tool for reading the workspace's version history (the platform-owned per-run snapshots,
// the same ones shown in the UI History panel). It is a SERVER-SIDE tool: it calls the versioning
// service in-process rather than through the container shell, so the versioning git-dir stays
// outside the agent's reach. The `sha` argument selects the mode — progressive disclosure:
//   - no sha  → compact overview of the last N snapshots, each with its per-file churn.
//   - sha set → that snapshot's full diff vs its parent (line-diff by default, word-diff opt-in).
// Output is token-optimized: numeric churn (not +/- glyphs), boilerplate stripped from diffs,
// git-standard @@ hunk headers kept, and hard caps so one fat snapshot can't flood the context.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { normalizeRelpath } from "../pathUtils";
import type { IWorkspaceVersioning, VersionStat } from "../../infra/interfaces";

const SHA = /^[0-9a-fA-F]{4,40}$/;
const MAX_FILES_PER_VERSION = 6;
const MAX_DIFF_LINES = 400;

const schema = z.object({
  n: z.number().int().min(1).max(20).optional()
    .describe("Overview mode only: how many recent snapshots to list (default 5, max 20)."),
  sha: z.string().optional()
    .describe("Omit to list recent snapshots. Pass a sha from that list to view what changed in it."),
  path: z.string().optional()
    .describe("Scope to one file/dir (relative to workspace root). In overview it filters the stats; in detail it narrows a large snapshot's diff."),
  word_diff: z.boolean().optional()
    .describe("Detail mode only: show an inline word-level diff instead of line-diff. Clearer for prose/small edits."),
  from: z.string().optional()
    .describe("Detail mode only (requires sha): a second, older sha from the overview. Shows the CUMULATIVE diff from `from` up to `sha` across snapshots, instead of just what `sha` changed on its own."),
  offset: z.number().int().min(0).optional()
    .describe("Detail mode only: skip this many diff lines, to page through a diff too large to fit. Default 0. The output footer reports the visible range and total line count."),
  limit: z.number().int().min(1).max(2000).optional()
    .describe("Detail mode only: max diff lines to return (default 400). Pair with offset to page a single large file that path can't narrow further."),
});

function churn(add: number, del: number): string {
  // Binary files report -1 for both (git emits "-" in numstat).
  if (add < 0 || del < 0) return "binary";
  return `+${add}/-${del}`;
}

function formatOverview(versions: VersionStat[]): string {
  if (versions.length === 0) return "No snapshots yet.";
  const blocks = versions.map((v) => {
    const nf = v.files.length;
    // (current) rides on the sha so it modifies the identity, never the free-text subject.
    const id = v.current ? `${v.sha} (current)` : v.sha;
    const header = `${id}  ${v.age}  ${nf} file${nf === 1 ? "" : "s"} ${churn(v.totalAdd, v.totalDel)}  ${v.subject}`;
    const shown = v.files.slice(0, MAX_FILES_PER_VERSION)
      .map((f) => `  ${f.path}  ${churn(f.add, f.del)}`);
    const more = nf - MAX_FILES_PER_VERSION;
    if (more > 0) shown.push(`  …+${more} more file${more === 1 ? "" : "s"}`);
    return [header, ...shown].join("\n");
  });
  return blocks.join("\n\n");
}

// Strip the per-file boilerplate git emits (diff --git / index / --- / +++) that carries no
// signal for the agent, while keeping the @@ hunk headers and +/- lines it is trained on. Then
// page the result by offset/limit and report the visible range vs the total so truncation is
// always quantified — the agent can tell exactly how much it has and page the rest.
function formatDetail(raw: string, offset = 0, limit = MAX_DIFF_LINES): string {
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (/^diff --git /.test(line)) {
      // Replace the noisy "diff --git a/x b/x" with just the file path as a section header.
      const m = line.match(/ b\/(.+)$/);
      out.push(m ? m[1] : line);
      continue;
    }
    if (/^(index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename )/.test(line)) continue;
    out.push(line);
  }
  // Drop leading blank lines left by the stripped commit header, and the trailing blank git's
  // final newline leaves — so neither inflates the line count nor shows as empty paged output.
  while (out.length && out[0].trim() === "") out.shift();
  while (out.length && out[out.length - 1].trim() === "") out.pop();

  const total = out.length;
  if (total === 0) return "";
  const start = Math.min(Math.max(0, offset), total);
  const end = Math.min(start + limit, total);
  const slice = out.slice(start, end);
  if (slice.length === 0) return `No diff lines at offset ${start} — this diff has ${total} line${total === 1 ? "" : "s"}.`;
  // Footer only when something is hidden (paged in from the start, or more remains).
  if (start > 0 || end < total) {
    slice.push(`… showing lines ${start + 1}-${end} of ${total}. Page with offset/limit, or narrow with path.`);
  }
  return slice.join("\n");
}

export class WorkspaceHistoryTool extends StructuredTool<typeof schema> {
  name = "workspace_history";
  description = `Review the workspace's version history — the automatic per-run snapshots (same ones the user sees in the History panel).

Two modes, selected by the sha argument:
- Omit sha → overview: the last N snapshots, each with sha, age, subject, and per-file churn (+added/-deleted). The snapshot the workspace is currently on is marked "(current)" — that is the live state on disk (it moves if the user restores an older snapshot), so don't assume the newest is current; read the marker.
- Pass a sha (from the overview) → detail: exactly what changed in that snapshot, as a diff.

Tips:
- Workflow is list first, then drill in: read the overview, pick the sha that matters, call again with it.
- path scopes things to one file/dir — use it to narrow a large snapshot's diff.
- from (with sha) shows the CUMULATIVE diff across snapshots — pass an older sha as from and a newer one as sha to see everything that changed between two runs.
- A large diff is paged: the footer reports "showing lines X-Y of Z". Use offset/limit to read the rest (e.g. offset 400) when path can't narrow a single big file further.
- word_diff gives an inline word-level diff; reach for it on prose or small edits when the line-diff reads noisy.
This is read-only: it never changes workspace files.`;
  schema = schema;

  constructor(
    private readonly workspaceId: string,
    private readonly workspaceDir: string,
    private readonly versioning: IWorkspaceVersioning,
  ) {
    super();
  }

  protected async _call({ n, sha, path, word_diff, from, offset, limit }: z.infer<typeof schema>): Promise<string> {
    let relpath: string | undefined;
    if (path !== undefined) {
      const normalized = normalizeRelpath(path);
      if (normalized === null) return "Error: path is outside the workspace";
      relpath = normalized;
    }

    try {
      if (sha === undefined) {
        let versions = await this.versioning.versionStats(this.workspaceId, this.workspaceDir, n ?? 5);
        if (relpath) {
          versions = versions
            .map((v) => {
              const files = v.files.filter((f) => f.path === relpath || f.path.startsWith(`${relpath}/`));
              const totalAdd = files.reduce((s, f) => s + (f.add > 0 ? f.add : 0), 0);
              const totalDel = files.reduce((s, f) => s + (f.del > 0 ? f.del : 0), 0);
              return { ...v, files, totalAdd, totalDel };
            })
            .filter((v) => v.files.length > 0);
        }
        return formatOverview(versions);
      }

      if (!SHA.test(sha)) return "Error: invalid sha — pass a sha from the overview (workspace_history with no sha).";
      if (from !== undefined && !SHA.test(from)) return "Error: invalid from sha — pass an older sha from the overview, or omit it.";
      const raw = await this.versioning.versionDiff(this.workspaceId, this.workspaceDir, sha, {
        path: relpath,
        wordDiff: word_diff,
        from,
      });
      if (raw.trim() === "") {
        return from
          ? "No changes between those snapshots (or unknown sha / path)."
          : "No changes in this snapshot (or unknown sha / path).";
      }
      return formatDetail(raw, offset, limit);
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

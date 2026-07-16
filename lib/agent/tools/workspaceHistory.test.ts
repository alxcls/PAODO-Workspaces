// WorkspaceHistoryTool turns the versioning service's structured data + raw diffs into the
// token-optimized text the agent reads. These tests pin the two modes (overview vs detail),
// the path containment guard, the sha guard, and the diff boilerplate-stripping.

import { describe, it, expect } from "vitest";
import { WorkspaceHistoryTool } from "./workspaceHistory";
import type { IWorkspaceVersioning, VersionStat } from "../../infra/interfaces";

const ID = "ws-1";
const DIR = "/tmp/ws";

// Minimal fake: only versionStats/versionDiff are exercised; the rest throw if touched.
function fakeVersioning(over: Partial<IWorkspaceVersioning>): IWorkspaceVersioning {
  const notUsed = () => {
    throw new Error("not used");
  };
  return {
    initRepo: notUsed,
    commitBaseline: notUsed,
    commitResult: notUsed,
    history: notUsed,
    diff: notUsed,
    restore: notUsed,
    deleteRepo: notUsed,
    isGitAvailable: notUsed as IWorkspaceVersioning["isGitAvailable"],
    versionStats: notUsed as IWorkspaceVersioning["versionStats"],
    versionDiff: notUsed as IWorkspaceVersioning["versionDiff"],
    ...over,
  };
}

function tool(over: Partial<IWorkspaceVersioning>): WorkspaceHistoryTool {
  return new WorkspaceHistoryTool(ID, DIR, fakeVersioning(over));
}

describe("WorkspaceHistoryTool — overview (no sha)", () => {
  const versions: VersionStat[] = [
    {
      sha: "deadbee",
      age: "2 hours ago",
      subject: "run 2 (user prompt): edits",
      files: [{ path: "src/a.ts", add: 10, del: 4 }],
      totalAdd: 10,
      totalDel: 4,
      current: true,
    },
    {
      sha: "abad1de",
      age: "3 hours ago",
      subject: "run 1 (user prompt): init",
      files: [{ path: "logo.png", add: -1, del: -1 }],
      totalAdd: 0,
      totalDel: 0,
    },
  ];

  it("renders one block per version with numeric churn, binary marker, and the (current) tag on the sha", async () => {
    const out = await tool({ versionStats: async () => versions }).invoke({});
    expect(out).toBe(
      // (current) rides on the sha of the snapshot the work-tree is on, not the newest by default.
      "deadbee (current)  2 hours ago  1 file +10/-4  run 2 (user prompt): edits\n" +
        "  src/a.ts  +10/-4\n\n" +
        // Binary files contribute 0 to the header totals; only the per-file line marks "binary".
        "abad1de  3 hours ago  1 file +0/-0  run 1 (user prompt): init\n" +
        "  logo.png  binary",
    );
  });

  it("caps the file list at 6 and notes the remainder", async () => {
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.ts`, add: 1, del: 0 }));
    const big: VersionStat[] = [{ sha: "s", age: "now", subject: "many", files, totalAdd: 9, totalDel: 0 }];
    const out = await tool({ versionStats: async () => big }).invoke({});
    expect(out).toContain("9 files +9/-0");
    expect(out.match(/^ {2}f\d\.ts/gm)).toHaveLength(6);
    expect(out).toContain("…+3 more files");
  });

  it("lists all snapshots by default and reports empty history", async () => {
    let seen: number | undefined = -1;
    const t = tool({
      versionStats: async (_id, _dir, n) => {
        seen = n;
        return [];
      },
    });
    expect(await t.invoke({})).toBe("No snapshots yet.");
    expect(seen).toBeUndefined();
  });

  it("passes the overview last limit through, including '-10' shorthand", async () => {
    let seen: number | undefined;
    const t = tool({
      versionStats: async (_id, _dir, n) => {
        seen = n;
        return versions;
      },
    });
    await t.invoke({ last: "-10" });
    expect(seen).toBe(10);
  });

  it("treats positive and negative last values the same: newest N snapshots", async () => {
    let seen: number | undefined;
    const t = tool({
      versionStats: async (_id, _dir, n) => {
        seen = n;
        return versions;
      },
    });
    await t.invoke({ last: 10 });
    expect(seen).toBe(10);
  });

  it("filters the overview to a path and drops versions that don't touch it", async () => {
    const out = await tool({ versionStats: async () => versions }).invoke({ path: "src" });
    expect(out).toContain("deadbee");
    expect(out).toContain("src/a.ts");
    expect(out).not.toContain("abad1de"); // only touched logo.png
  });

  it("rejects a path outside the workspace", async () => {
    const out = await tool({ versionStats: async () => versions }).invoke({ path: "../etc" });
    expect(out).toBe("Error: path is outside the workspace");
  });
});

describe("WorkspaceHistoryTool — detail (sha given)", () => {
  const rawDiff =
    "commit deadbee\n" +
    "Author: x\n\n" +
    "diff --git a/README.md b/README.md\n" +
    "index aabf31d..a26fd3b 100644\n" +
    "--- a/README.md\n" +
    "+++ b/README.md\n" +
    "@@ -98,7 +98,7 @@\n" +
    "-old line\n" +
    "+new line\n";

  it("strips git boilerplate but keeps @@ hunks and +/- lines", async () => {
    let opts: unknown;
    const t = tool({
      versionDiff: async (_i, _d, _s, o) => {
        opts = o;
        return rawDiff;
      },
    });
    const out = await t.invoke({ sha: "deadbee" });
    expect(out).toContain("README.md");
    expect(out).toContain("@@ -98,7 +98,7 @@");
    expect(out).toContain("-old line");
    expect(out).toContain("+new line");
    expect(out).not.toContain("diff --git");
    expect(out).not.toContain("index aabf31d");
    expect(out).not.toContain("--- a/README.md");
    expect(opts).toEqual({ path: undefined });
  });

  it("forwards path scope to the service", async () => {
    let opts: unknown;
    const t = tool({
      versionDiff: async (_i, _d, _s, o) => {
        opts = o;
        return rawDiff;
      },
    });
    await t.invoke({ sha: "deadbee", path: "README.md" });
    expect(opts).toEqual({ path: "README.md" });
  });

  it("rejects a non-hex sha before calling the service", async () => {
    let called = false;
    const t = tool({
      versionDiff: async () => {
        called = true;
        return "";
      },
    });
    const out = await t.invoke({ sha: "not a sha!" });
    expect(out).toContain("invalid sha");
    expect(called).toBe(false);
  });

  it("reports an empty diff gracefully", async () => {
    const t = tool({ versionDiff: async () => "" });
    expect(await t.invoke({ sha: "deadbee" })).toContain("No changes in this snapshot");
  });

  // A diff with 6 stripped content lines (1 file header + @@ + 4 +/- lines) for paging assertions.
  const longDiff = "diff --git a/f.ts b/f.ts\n" + "@@ -1,4 +1,4 @@\n" + "-a\n+b\n-c\n+d\n";

  it("quantifies truncation: footer reports the visible range and total line count", async () => {
    const t = tool({ versionDiff: async () => longDiff });
    // 6 lines total (f.ts, @@, -a, +b, -c, +d); limit 2 shows the first 2 and names the total.
    const out = await t.invoke({ sha: "deadbee", limit: 2 });
    expect(out).toContain("f.ts");
    expect(out).toContain("@@ -1,4 +1,4 @@");
    expect(out).toContain("showing lines 1-2 of 6");
    expect(out).not.toContain("-a"); // line 3 onward is paged out
  });

  it("pages with offset: a later window reports its own range", async () => {
    const t = tool({ versionDiff: async () => longDiff });
    const out = await t.invoke({ sha: "deadbee", offset: 2, limit: 2 });
    expect(out).toContain("-a");
    expect(out).toContain("+b");
    expect(out).toContain("showing lines 3-4 of 6");
    expect(out).not.toContain("f.ts"); // line 1 is before the window
  });

  it("omits the footer when the whole diff fits", async () => {
    const t = tool({ versionDiff: async () => longDiff });
    const out = await t.invoke({ sha: "deadbee" }); // default limit 400 > 6 lines
    expect(out).not.toContain("showing lines");
    expect(out).toContain("+d");
  });
});

// glob and list_directory both build their answer from one `find` whose output the docker client
// caps at 8MB. A cut listing is indistinguishable from a complete one — "no files matched" and "we
// stopped looking" are different answers — so both have to say when they were cut. file_read and the
// git diff paths already do; these two were the pair still returning a prefix as if it were the whole.
import { describe, it, expect } from "vitest";
import { GlobTool } from "./glob";
import { ListDirectoryTool } from "./listDirectory";
import type { ExecRunner, ExecResult } from "../interfaces";

function runnerReturning(result: Partial<ExecResult>): ExecRunner {
  return { exec: async () => ({ code: 0, stdout: "", stderr: "", ...result }) };
}

const call = (tool: GlobTool | ListDirectoryTool, args: Record<string, unknown>) =>
  (tool as unknown as { _call: (a: Record<string, unknown>) => Promise<string> })._call(args);

describe("listings that were cut short", () => {
  it("glob says the search stopped rather than implying it finished", async () => {
    const runner = runnerReturning({ stdout: "f\tsrc/a.ts\nf\tsrc/b.ts\n", truncated: true });

    const out = await call(new GlobTool(runner), { pattern: "src/*.ts" });

    expect(out).toContain("src/a.ts");
    expect(out).toContain("listing truncated");
  });

  it("glob distinguishes 'nothing matched' from 'we stopped looking'", async () => {
    const runner = runnerReturning({ stdout: "f\tsrc/a.js\n", truncated: true });

    const out = await call(new GlobTool(runner), { pattern: "**/*.ts" });

    // The dangerous read of a bare "No files matched." is that the agent concludes the file is absent
    // and goes off to create it.
    expect(out).toContain("No files matched.");
    expect(out).toContain("listing truncated");
  });

  it("glob stays quiet when the listing was whole", async () => {
    const runner = runnerReturning({ stdout: "f\tsrc/a.ts\n", truncated: false });

    expect(await call(new GlobTool(runner), { pattern: "src/*.ts" })).toBe("src/a.ts");
  });

  it("list_directory says so too", async () => {
    const runner = runnerReturning({ stdout: "1\tf\t1700000000\t/workspace\tnotes.txt\n", truncated: true });

    const out = await call(new ListDirectoryTool(runner), { dir_path: "." });

    expect(out).toContain("notes.txt");
    expect(out).toContain("listing truncated");
  });

  it("list_directory stays quiet when the listing was whole", async () => {
    const runner = runnerReturning({ stdout: "1\tf\t1700000000\t/workspace\tnotes.txt\n", truncated: false });

    expect(await call(new ListDirectoryTool(runner), { dir_path: "." })).not.toContain("truncated");
  });
});

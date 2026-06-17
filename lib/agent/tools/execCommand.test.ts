// ExecCommandTool must surface a non-zero exit code as an explicit "Error:" line so both the
// agent and the usage dashboard (via runner.classifyToolStatus) can tell the command failed —
// the combined stdout/stderr alone hides exit status. Code 0 stays plain output.
import { describe, it, expect } from "vitest";
import { ExecCommandTool } from "./execCommand";
import type { StreamingExecFn } from "../interfaces";

// A streamExec stub that emits the given stdout/stderr then resolves with the given exit code.
function fakeExec(out: { stdout?: string; stderr?: string; code: number | null }): StreamingExecFn {
  return async (_cmd, { onStdout, onStderr }) => {
    if (out.stdout) onStdout(out.stdout);
    if (out.stderr) onStderr(out.stderr);
    return { code: out.code };
  };
}

function makeTool(exec: StreamingExecFn) {
  return new ExecCommandTool(exec, () => {}, { silenceTimeoutMs: 60_000, maxTimeoutMs: 60_000 });
}

describe("ExecCommandTool exit-code surfacing", () => {
  it("leads a non-zero exit with an Error line", async () => {
    const tool = makeTool(fakeExec({ stdout: "compiling...", code: 1 }));
    const result = await tool.invoke({ command: "npm run build" });
    expect(result).toMatch(/^Error: command exited with code 1/);
    expect(result).toContain("compiling...");
  });

  it("leaves a successful (code 0) command as plain output", async () => {
    const tool = makeTool(fakeExec({ stdout: "ok", code: 0 }));
    const result = await tool.invoke({ command: "true" });
    expect(result).not.toMatch(/^Error:/);
    expect(result).toContain("ok");
  });

  it("does not flag an unknown (null) exit code as an error", async () => {
    const tool = makeTool(fakeExec({ stdout: "ran", code: null }));
    const result = await tool.invoke({ command: "weird" });
    expect(result).not.toMatch(/^Error:/);
  });

  it("surfaces a hard exec failure (rejected streamExec) as an Error line", async () => {
    const failingExec: StreamingExecFn = async () => { throw new Error("docker not running"); };
    const tool = makeTool(failingExec);
    const result = await tool.invoke({ command: "ls" });
    expect(result).toMatch(/^Error:/);
    expect(result).toContain("docker not running");
  });
});

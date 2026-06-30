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

// A streamExec stub that mimics a long-running process: it never resolves on its own, only when
// its abort signal fires (as the real container kill would). sawAbort() reports whether the kill
// was propagated down to this layer.
function hangingExec(): { exec: StreamingExecFn; sawAbort: () => boolean } {
  let signal: AbortSignal | undefined;
  const exec: StreamingExecFn = (_cmd, { signal: s }) =>
    new Promise((resolve) => {
      signal = s;
      s?.addEventListener("abort", () => resolve({ code: null }));
    });
  return { exec, sawAbort: () => !!signal?.aborted };
}

function makeTool(exec: StreamingExecFn) {
  return new ExecCommandTool(exec, () => {}, { silenceTimeoutMs: 60_000, maxTimeoutMs: 60_000 });
}

describe("ExecCommandTool exit-code surfacing", () => {
  // A failing command (exit 1) is tagged with a leading "Error:" line.
  it("leads a non-zero exit with an Error line", async () => {
    const tool = makeTool(fakeExec({ stdout: "compiling...", code: 1 }));
    const result = await tool.invoke({ command: "npm run build" });
    expect(result).toMatch(/^Error: command exited with code 1/);
    expect(result).toContain("compiling...");
  });

  // A successful command (exit 0) stays plain output, no Error prefix.
  it("leaves a successful (code 0) command as plain output", async () => {
    const tool = makeTool(fakeExec({ stdout: "ok", code: 0 }));
    const result = await tool.invoke({ command: "true" });
    expect(result).not.toMatch(/^Error:/);
    expect(result).toContain("ok");
  });

  // An unknown exit code (null, e.g. killed by signal) is not treated as a failure.
  it("does not flag an unknown (null) exit code as an error", async () => {
    const tool = makeTool(fakeExec({ stdout: "ran", code: null }));
    const result = await tool.invoke({ command: "weird" });
    expect(result).not.toMatch(/^Error:/);
  });

  // A thrown exec failure (e.g. Docker down) surfaces as an Error line, not a crash.
  it("surfaces a hard exec failure (rejected streamExec) as an Error line", async () => {
    const failingExec: StreamingExecFn = async () => { throw new Error("docker not running"); };
    const tool = makeTool(failingExec);
    const result = await tool.invoke({ command: "ls" });
    expect(result).toMatch(/^Error:/);
    expect(result).toContain("docker not running");
  });
});

describe("ExecCommandTool sudo guard", () => {
  // sudo is unavailable in the container; the tool rejects it without ever invoking the exec layer.
  it("rejects a sudo command and points to run_privileged_script", async () => {
    let invoked = false;
    const spyExec: StreamingExecFn = async () => { invoked = true; return { code: 0 }; };
    const tool = makeTool(spyExec);
    const result = await tool.invoke({ command: "sudo apt-get install cowsay" });
    expect(result).toMatch(/^Error: sudo is not available/);
    expect(result).toContain("run_privileged_script");
    expect(invoked).toBe(false);
  });

  it("does not flag a command that merely contains 'sudo' as a substring", async () => {
    const tool = makeTool(fakeExec({ stdout: "ok", code: 0 }));
    const result = await tool.invoke({ command: "echo pseudonym" });
    expect(result).not.toMatch(/sudo is not available/);
  });
});

describe("ExecCommandTool user abort (escape)", () => {
  // Escape mid-command returns at once and fires the kill down to the exec layer.
  it("stops promptly and propagates the kill to the exec layer when the user aborts", async () => {
    const { exec, sawAbort } = hangingExec();
    const tool = makeTool(exec);
    const controller = new AbortController();

    const resultP = tool.invoke({ command: "sleep 999" }, { signal: controller.signal });
    controller.abort();                       // user hits escape mid-command
    const result = await resultP;

    expect(sawAbort()).toBe(true);            // kill reached streamExec (real in-container kill)
    expect(result).toContain("Stopped by user");
  });

  // A signal already aborted before the call still stops immediately and kills.
  it("returns immediately if the signal is already aborted before the call", async () => {
    const { exec, sawAbort } = hangingExec();
    const tool = makeTool(exec);
    const controller = new AbortController();
    controller.abort();

    const result = await tool.invoke({ command: "sleep 999" }, { signal: controller.signal });

    expect(sawAbort()).toBe(true);
    expect(result).toContain("Stopped by user");
  });
});

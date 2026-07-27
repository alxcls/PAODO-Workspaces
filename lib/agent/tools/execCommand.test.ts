// ExecCommandTool must surface a non-zero exit code as an explicit "Error:" line so both the
// agent and the usage dashboard (via runner.classifyToolStatus) can tell the command failed —
// the combined stdout/stderr alone hides exit status. Code 0 stays plain output.
//
// checkFreeSpace is mocked (not exercised against a real filesystem) so every test below controls
// disk state deterministically — most tests just need it to stay out of the way (ok: true), and the
// dedicated disk-space-guard tests flip it to simulate a full disk.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecCommandTool } from "./execCommand";
import type { StreamingExecFn, BackgroundExecFn } from "../interfaces";

const checkFreeSpace = vi.hoisted(() => vi.fn());
vi.mock("../../workspace/diskSpace", () => ({ checkFreeSpace, RESERVED_FREE_BYTES: 1024 * 1024 * 1024 }));

beforeEach(() => {
  checkFreeSpace.mockReset();
  checkFreeSpace.mockResolvedValue({ ok: true, freeBytes: Infinity });
});

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

// A background-exec stub that records the command it was asked to launch.
function fakeBackground(): { fn: BackgroundExecFn; calls: string[] } {
  const calls: string[] = [];
  const fn: BackgroundExecFn = async (command) => {
    calls.push(command);
    return { taskId: "task-123", logFile: "/tmp/paodo-tasks/task-123.output" };
  };
  return { fn, calls };
}

function makeTool(exec: StreamingExecFn, background: BackgroundExecFn = fakeBackground().fn) {
  return new ExecCommandTool(
    exec,
    background,
    () => {},
    { silenceTimeoutMs: 60_000, maxTimeoutMs: 60_000 },
    "/workspace/test",
  );
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
    const failingExec: StreamingExecFn = async () => {
      throw new Error("docker not running");
    };
    const tool = makeTool(failingExec);
    const result = await tool.invoke({ command: "ls" });
    expect(result).toMatch(/^Error:/);
    expect(result).toContain("docker not running");
  });
});

describe("ExecCommandTool run_in_background", () => {
  // Background commands route to backgroundExec and NEVER touch the abortable streamExec path —
  // that separation is what keeps a server alive past the silence/max timeout.
  it("routes to backgroundExec (not streamExec) and returns the task ID + log path", async () => {
    const { fn, calls } = fakeBackground();
    let streamExecCalled = false;
    const exec: StreamingExecFn = async () => {
      streamExecCalled = true;
      return { code: 0 };
    };
    const tool = makeTool(exec, fn);

    const result = await tool.invoke({ command: "python3 -m http.server 8080", run_in_background: true });

    expect(calls).toEqual(["python3 -m http.server 8080"]);
    expect(streamExecCalled).toBe(false);
    expect(result).toContain("task ID: task-123");
    expect(result).toContain("/tmp/paodo-tasks/task-123.output");
  });

  // Even if the signal is already aborted, a background launch is unaffected — no kill path applies.
  it("ignores an aborted signal (background is fire-and-forget)", async () => {
    const { exec, sawAbort } = hangingExec();
    const tool = makeTool(exec);
    const controller = new AbortController();
    controller.abort();

    const result = await tool.invoke(
      { command: "npm run dev", run_in_background: true },
      { signal: controller.signal },
    );

    expect(sawAbort()).toBe(false); // background path never wires the abort signal
    expect(result).toContain("task ID: task-123");
  });

  // A launch failure surfaces as an Error line, not a crash.
  it("surfaces a background launch failure as an Error line", async () => {
    const failing: BackgroundExecFn = async () => {
      throw new Error("background launch failed");
    };
    const tool = makeTool(fakeExec({ code: 0 }), failing);
    const result = await tool.invoke({ command: "npm run dev", run_in_background: true });
    expect(result).toMatch(/^Error:/);
    expect(result).toContain("background launch failed");
  });
});

describe("ExecCommandTool user abort (escape)", () => {
  // Escape mid-command returns at once and fires the kill down to the exec layer.
  it("stops promptly and propagates the kill to the exec layer when the user aborts", async () => {
    const { exec, sawAbort } = hangingExec();
    const tool = makeTool(exec);
    const controller = new AbortController();

    const resultP = tool.invoke({ command: "sleep 999" }, { signal: controller.signal });
    controller.abort(); // user hits escape mid-command
    const result = await resultP;

    expect(sawAbort()).toBe(true); // kill reached streamExec (real in-container kill)
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

describe("ExecCommandTool silence heartbeat", () => {
  // The "still running" line is reassurance, not information. It must appear quickly (so a slow
  // command doesn't look hung) but then back off, or a quiet multi-minute build buries the terminal
  // in identical lines.
  it("emits every 5s for the first 30s of silence, then every 30s", async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const { exec } = hangingExec();
      const tool = new ExecCommandTool(
        exec,
        fakeBackground().fn,
        (msg) => {
          const parsed = JSON.parse(msg);
          if (typeof parsed.data === "string" && parsed.data.includes("still running")) lines.push(parsed.data);
        },
        { silenceTimeoutMs: 5 * 60_000, maxTimeoutMs: 30 * 60_000 },
        "/workspace/test",
      );

      void tool.invoke({ command: "npm install" });
      await vi.advanceTimersByTimeAsync(0); // let the pre-flight disk check resolve

      // First 30s: ticks at 5,10,15,20,25s emit (the 30s tick has silentMs === 30_000, already backed off).
      await vi.advanceTimersByTimeAsync(30_000);
      expect(lines).toHaveLength(5);

      // Next 60s at the backed-off cadence adds only two more, not twelve.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lines).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });

  // Real output resets the silence window, so the fast cadence returns for the next quiet stretch
  // rather than staying stuck at the 30s backoff.
  it("returns to the 5s cadence after the command produces output", async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      let emit: ((text: string) => void) | undefined;
      const exec: StreamingExecFn = (_cmd, { onStdout, signal }) =>
        new Promise((resolve) => {
          emit = onStdout;
          signal?.addEventListener("abort", () => resolve({ code: null }));
        });
      const tool = new ExecCommandTool(
        exec,
        fakeBackground().fn,
        (msg) => {
          const parsed = JSON.parse(msg);
          if (typeof parsed.data === "string" && parsed.data.includes("still running")) lines.push(parsed.data);
        },
        { silenceTimeoutMs: 5 * 60_000, maxTimeoutMs: 30 * 60_000 },
        "/workspace/test",
      );

      void tool.invoke({ command: "npm install" });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(60_000); // 5 fast + 1 backed-off tick
      const backedOff = lines.length;

      emit?.("added 1200 packages\n"); // output resets lastOutputAt
      await vi.advanceTimersByTimeAsync(15_000); // ticks at 5s and 10s of fresh silence
      expect(lines.length).toBe(backedOff + 3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ExecCommandTool disk-space guard", () => {
  // A shell command has no declared size the way an HTTP upload does — the only thing worth
  // checking up front is "is there still room at all."
  it("refuses to start a foreground command when the workspace is already out of disk space", async () => {
    checkFreeSpace.mockResolvedValue({ ok: false, freeBytes: 0 });
    let execCalled = false;
    const exec: StreamingExecFn = async () => {
      execCalled = true;
      return { code: 0 };
    };
    const tool = makeTool(exec);

    const result = await tool.invoke({ command: "git clone https://example.com/huge.git" });

    expect(result).toMatch(/^Error:/);
    expect(result).toContain("out of free disk space");
    expect(execCalled).toBe(false);
  });

  it("refuses to start a background command when the workspace is already out of disk space", async () => {
    checkFreeSpace.mockResolvedValue({ ok: false, freeBytes: 0 });
    const { fn, calls } = fakeBackground();
    const tool = makeTool(fakeExec({ code: 0 }), fn);

    const result = await tool.invoke({ command: "npm install", run_in_background: true });

    expect(result).toMatch(/^Error:/);
    expect(calls).toEqual([]);
  });

  it("kills a long-running command mid-run once the workspace runs out of disk space", async () => {
    vi.useFakeTimers();
    try {
      const { exec, sawAbort } = hangingExec();
      const tool = makeTool(exec);

      const resultP = tool.invoke({ command: "git clone https://example.com/huge.git" });
      // Let the pre-flight check (ok: true) resolve and streamExec start hanging.
      await vi.advanceTimersByTimeAsync(0);

      // Disk fills up partway through the run — the periodic heartbeat check should catch it on
      // its next 5s tick.
      checkFreeSpace.mockResolvedValue({ ok: false, freeBytes: 0 });
      await vi.advanceTimersByTimeAsync(5_000);

      const result = await resultP;
      expect(sawAbort()).toBe(true);
      expect(result).toContain("ran out of disk space");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ExecCommandTool must surface a non-zero exit code as an explicit "Error:" line so both the
// agent and the usage dashboard (via runner.classifyToolStatus) can tell the command failed —
// the combined stdout/stderr alone hides exit status. Code 0 stays plain output.
//
// checkFreeSpace is mocked (not exercised against a real filesystem) so every test below controls
// disk state deterministically — most tests just need it to stay out of the way (ok: true), and the
// dedicated disk-space-guard tests flip it to simulate a full disk.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecCommandTool } from "./execCommand";
import type { StreamingExecFn, BackgroundExecFn, OutputSinkFn } from "../interfaces";
import { MAX_INLINE_BYTES, PREVIEW_BYTES } from "@/lib/infra/limits";

const checkFreeSpace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/storage/diskSpace", () => ({ checkFreeSpace, RESERVED_FREE_BYTES: 1024 * 1024 * 1024 }));

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

// A sink stub that records what the over-cap path would have written into the container, so tests can
// assert the full output survives without needing Docker.
function fakeSink(limit = 50 * 1024 * 1024): { fn: OutputSinkFn; saved: () => string; opened: () => number } {
  const chunks: Buffer[] = [];
  let opened = 0;
  const fn: OutputSinkFn = (runId) => {
    opened += 1;
    return {
      path: `/tmp/paodo-exec/${runId}.output`,
      limit,
      truncated: false,
      write: (chunk: Buffer) => void chunks.push(chunk),
      close: () => {},
    };
  };
  return { fn, saved: () => Buffer.concat(chunks).toString("utf8"), opened: () => opened };
}

function makeTool(
  exec: StreamingExecFn,
  background: BackgroundExecFn = fakeBackground().fn,
  openSink: OutputSinkFn = fakeSink().fn,
) {
  return new ExecCommandTool(
    exec,
    background,
    () => {},
    { silenceTimeoutMs: 60_000, maxTimeoutMs: 60_000 },
    "/workspace/test",
    openSink,
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
        fakeSink().fn,
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
        fakeSink().fn,
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

// Output volume used to be an unbounded liability: `stdout += chunk` had no ceiling, and past V8's
// max string length the += threw from inside a stream handler — off any promise chain, so it reached
// server.ts's uncaughtException guard and exited the process, taking every workspace with it. These
// tests pin the two properties that replaced it: the tool result stays small no matter what a command
// prints, and nothing is lost when it does.
describe("ExecCommandTool output limits", () => {
  it("returns modest output whole, with no file involved", async () => {
    const sink = fakeSink();
    const tool = makeTool(fakeExec({ stdout: "build succeeded\n", code: 0 }), fakeBackground().fn, sink.fn);

    const result = await tool.invoke({ command: "npm run build" });

    expect(result).toBe("build succeeded");
    expect(result).not.toContain("Output too large");
    expect(sink.opened()).toBe(0);
  });

  it("caps a huge result and hands the agent the path instead", async () => {
    const huge = "L".repeat(MAX_INLINE_BYTES * 20);
    const sink = fakeSink();
    const tool = makeTool(fakeExec({ stdout: huge, code: 0 }), fakeBackground().fn, sink.fn);

    const result = await tool.invoke({ command: "cat big.bin" });

    // The whole point: what reaches the agent (and the model's context) is bounded, whatever the
    // command printed. Before this, a result this size was either a crash or an unusable context.
    expect(result.length).toBeLessThan(PREVIEW_BYTES * 2);
    expect(result).toContain("Output too large");
    expect(result).toContain("/tmp/paodo-exec/");
    expect(sink.opened()).toBe(1);
    // ...and it is bounded without losing anything — the file holds every byte.
    expect(sink.saved()).toBe(huge);
  });

  it("still leads a failed command with its exit code when the output overflowed", async () => {
    const sink = fakeSink();
    const tool = makeTool(
      fakeExec({ stdout: "T".repeat(MAX_INLINE_BYTES * 2), code: 1 }),
      fakeBackground().fn,
      sink.fn,
    );

    const result = await tool.invoke({ command: "npm run build" });

    // classifyToolStatus keys off this line, so overflow must not swallow the failure signal.
    expect(result.startsWith("Error: command exited with code 1")).toBe(true);
    expect(result).toContain("Output too large");
  });

  it("still explains WHY a command failed when its output overflowed", async () => {
    const sink = fakeSink();
    const tool = makeTool(
      fakeExec({
        stdout: "N".repeat(MAX_INLINE_BYTES * 2),
        stderr: "exec: no matching entries in passwd file",
        code: 1,
      }),
      fakeBackground().fn,
      sink.fn,
    );

    const result = await tool.invoke({ command: "npm run build" });

    // The saved file holds the command's own output — but this guidance is OURS, generated from the
    // stderr signature, so if overflow drops it the agent cannot recover it by reading the file. It
    // would instead be told to go read a 600KB log to find out why the container is broken.
    expect(result).toContain("Output too large");
    expect(result).toContain("no matching entries in passwd file");
    expect(result).toContain("[setup]");
    expect(result).toContain("Do NOT suggest deleting or recreating the container");
  });

  it("saves what a killed command produced before the kill", async () => {
    vi.useFakeTimers();
    try {
      const sink = fakeSink();
      let emit: ((text: string) => void) | undefined;
      const exec: StreamingExecFn = (_cmd, { onStdout, signal }) =>
        new Promise((resolve) => {
          emit = onStdout;
          signal?.addEventListener("abort", () => resolve({ code: null }));
        });
      const tool = makeTool(exec, fakeBackground().fn, sink.fn);

      const resultP = tool.invoke({ command: "yes" });
      await vi.advanceTimersByTimeAsync(0);
      emit!("R".repeat(MAX_INLINE_BYTES * 2));

      // Run past the max-runtime guard so the command is killed mid-stream.
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultP;

      expect(result).toContain("[killed]");
      // A killed runaway is exactly the case where the operator most wants the output kept.
      expect(sink.saved().length).toBe(MAX_INLINE_BYTES * 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

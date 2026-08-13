// One ceiling on what a spawned child process may materialize in this process, shared by every
// spawner we own (dockerClient, gitClient).
//
// WHY it lives here rather than in each spawner: `stdout += d.toString()` inside a "data" handler
// has no ceiling, and past V8's maximum string length (~536M chars) the `+=` throws RangeError from
// a callback Node invokes DIRECTLY — not from the promise the spawner returns, so no .catch() sees
// it. It lands on server.ts's uncaughtException guard, which fatal()s, taking every workspace,
// socket and in-flight run on the instance down with it.
//
// A per-spawner copy of the fix is exactly how gitClient kept the bug after dockerClient was capped:
// its own header says it "mirrors dockerClient._spawn", and it mirrored the defect too. One ceiling,
// called from both, is the difference between fixing this class of bug and fixing one instance of it.
//
// Deliberately generous: this is the floor that stops a subprocess taking the process down, not a
// product-level limit. Tools wanting a smaller, meaningful bound impose their own (see fileRead,
// which stops the bytes at the source instead of transferring them just to drop them).
import type { ChildProcess } from "child_process";

export const MAX_CAPTURE_BYTES = parseInt(process.env.SPAWN_MAX_CAPTURE_BYTES ?? "", 10) || 8 * 1024 * 1024;

export class SpawnCapture {
  private text = { stdout: "", stderr: "" };
  private bytes = { stdout: 0, stderr: 0 };
  private capped = false;

  constructor(private readonly limit: number = MAX_CAPTURE_BYTES) {}

  /** Wires both output streams of a freshly spawned child. The caller still owns close/error. */
  attach(proc: ChildProcess): void {
    proc.stdout?.on("data", (d: Buffer) => this.push("stdout", d));
    proc.stderr?.on("data", (d: Buffer) => this.push("stderr", d));
    // A stream that errors (child torn down mid-write) would otherwise raise an unhandled 'error'
    // event; the caller's close/error handlers are what actually settle the call.
    proc.stdout?.on("error", () => {});
    proc.stderr?.on("error", () => {});
  }

  /** Each stream gets its own budget, so a noisy failure on stderr cannot crowd stdout out. */
  push(stream: "stdout" | "stderr", d: Buffer): void {
    const room = this.limit - this.bytes[stream];
    if (room <= 0) {
      this.capped = true;
      return;
    }
    if (d.length > room) this.capped = true;
    const slice = d.length <= room ? d : d.subarray(0, room);
    this.text[stream] += slice.toString();
    this.bytes[stream] += slice.length;
  }

  get stdout(): string {
    return this.text.stdout;
  }

  get stderr(): string {
    return this.text.stderr;
  }

  /** True when either stream hit the ceiling, i.e. what is held is only the leading part. */
  get truncated(): boolean {
    return this.capped;
  }
}

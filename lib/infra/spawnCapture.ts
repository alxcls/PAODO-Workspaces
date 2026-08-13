// One ceiling on what a spawned child process may materialize here, shared by dockerClient and
// gitClient. Unbounded `stdout += d.toString()` throws RangeError past V8's ~536M char string limit,
// and it throws from a "data" handler Node invokes directly — so it reaches server.ts's
// uncaughtException guard, not the spawner's promise, and exits the instance.
//
// Shared rather than copied because a copy is how gitClient kept the bug after dockerClient was
// capped. A safety floor, not a product limit: tools needing a meaningful bound set their own.
import type { ChildProcess } from "child_process";
import { MAX_CAPTURE_BYTES } from "./limits";

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

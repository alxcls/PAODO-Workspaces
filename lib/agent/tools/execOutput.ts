// Bounds how much of a command's output the app holds in memory, and preserves the rest on disk.
//
// execCommand used to do `stdout += chunk` with no ceiling. That is not a safe operation: past V8's
// maximum string length (~536M chars) the `+=` throws RangeError, and it throws from inside the
// Docker stream's "data" handler — a callback Node invokes directly, not something on the promise
// chain execCommand catches. So it escaped to process.on("uncaughtException") in server.ts, which
// fatal()s by design, taking down every workspace, WebSocket session and in-flight run on the
// instance. A command printing a binary or a verbose build log got there in under a second, and none
// of the container limits applied: the memory was in the app, not the container.
//
// The cap makes that unreachable. The spill file is what stops the cap from losing anything: past
// the cap the output keeps streaming into a file inside the container, where the agent's own shell
// can grep or tail it — the same place background task logs already live.

import type { OutputSink } from "../../infra/interfaces";

/** Output at or under this stays inline in the tool result, whole. Matches Claude Code's threshold. */
export const MAX_INLINE_BYTES = 30_000;

/** How much of an over-cap output is shown inline, as a head preview. Claude Code shows 2KB. */
export const PREVIEW_BYTES = 2_048;

/** Byte size for the truncation notice — "29.4KB", "1.2MB". Mirrors Claude Code's KiB/MiB rendering. */
export function formatOutputBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value}B` : `${(Math.round(value * 10) / 10).toFixed(1)}${units[unit]}`;
}

/**
 * Accumulator for one command's output, shared by its stdout and stderr streams.
 *
 * Under the cap it behaves exactly as the old string concatenation did — the streams stay separate
 * so diagnoseStderr and the existing result format still work on whole output. Over the cap it stops
 * retaining and hands everything to a sink instead, keeping only a head preview.
 */
export class ExecOutput {
  // Arrival-order copy, used to flush a complete file at spill time and to cut the preview. Only
  // retained until the spill happens, which is the only moment it is needed.
  private ordered: Buffer[] = [];
  private stdoutKept: Buffer[] = [];
  private stderrKept: Buffer[] = [];
  private inlineBytes = 0;
  private totalBytes = 0;
  private sink: OutputSink | null = null;
  private preview: Buffer | null = null;

  /** openSink is called at most once, lazily — a command that stays under the cap never spawns one. */
  constructor(
    private readonly openSink: () => OutputSink,
    private readonly limit = MAX_INLINE_BYTES,
  ) {}

  append(stream: "stdout" | "stderr", text: string): void {
    const buf = Buffer.from(text, "utf8");
    this.totalBytes += buf.length;

    if (this.sink) {
      this.sink.write(buf);
      return;
    }

    // Retain the WHOLE crossing chunk before deciding to spill. Truncating it here instead would
    // drop the bytes between the cap and the chunk boundary, and those bytes would then be missing
    // from the file too — the one place the output is supposed to survive intact.
    this.ordered.push(buf);
    (stream === "stdout" ? this.stdoutKept : this.stderrKept).push(buf);
    this.inlineBytes += buf.length;
    if (this.inlineBytes > this.limit) this.spill();
  }

  private spill(): void {
    const all = Buffer.concat(this.ordered);
    this.preview = all.subarray(0, PREVIEW_BYTES);
    this.sink = this.openSink();
    this.sink.write(all);
    // Everything retained for the inline path is now either in the preview or in the file. Dropping
    // these is what actually bounds the memory — without it the cap would only slow the growth.
    this.ordered = [];
    this.stdoutKept = [];
    this.stderrKept = [];
  }

  /** True once output passed the cap, i.e. the result is a preview + file rather than whole output. */
  get overflowed(): boolean {
    return this.sink !== null;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  stdoutText(): string {
    return Buffer.concat(this.stdoutKept).toString("utf8");
  }

  stderrText(): string {
    return Buffer.concat(this.stderrKept).toString("utf8");
  }

  /**
   * The inline block for an over-cap result: size, where the full output went, and the head preview.
   * Shaped after Claude Code's own message so the agent reads a familiar contract — a preview plus a
   * path it is expected to go query, not a dead end.
   */
  overflowNotice(): string {
    const sink = this.sink;
    if (!sink || !this.preview) return "";
    const lines = [
      `Output too large (${formatOutputBytes(this.totalBytes)}). Full output saved to: ${sink.path}`,
      `Read it with execute_command, e.g. tail -n 200 ${sink.path} or grep -n "error" ${sink.path}.`,
    ];
    if (sink.truncated) {
      // The file has its own ceiling, so "full output" would otherwise be a promise we did not keep.
      lines.push(`(The saved file itself was capped — it holds the first ${formatOutputBytes(sink.limit)}.)`);
    }
    lines.push("", `Preview (first ${formatOutputBytes(PREVIEW_BYTES)}):`, this.preview.toString("utf8"), "...");
    return lines.join("\n");
  }

  /** Closes the sink if one was opened. Safe to call when the command produced little output. */
  close(): void {
    this.sink?.close();
  }
}

// ExecOutput is the ceiling that makes an unbounded `stdout += chunk` unreachable. The tests that
// matter most here are not the formatting ones — they are the two that guarantee the ceiling is real
// (memory stops growing) and that reaching it costs nothing (every byte still lands in the sink).
import { describe, it, expect } from "vitest";
import { ExecOutput, MAX_INLINE_BYTES, PREVIEW_BYTES, formatOutputBytes } from "./execOutput";
import type { OutputSink } from "../../infra/interfaces";

function recordingSink(overrides: Partial<OutputSink> = {}) {
  const chunks: Buffer[] = [];
  let closed = false;
  const sink: OutputSink = {
    path: "/tmp/paodo-exec/test.output",
    limit: 50 * 1024 * 1024,
    truncated: false,
    write: (c) => void chunks.push(c),
    close: () => {
      closed = true;
    },
    ...overrides,
  };
  return { sink, saved: () => Buffer.concat(chunks).toString("utf8"), isClosed: () => closed };
}

function makeOutput(overrides: Partial<OutputSink> = {}) {
  const rec = recordingSink(overrides);
  let opened = 0;
  const output = new ExecOutput(() => {
    opened += 1;
    return rec.sink;
  });
  return { output, ...rec, opened: () => opened };
}

describe("ExecOutput", () => {
  it("returns output whole and opens no sink while under the cap", () => {
    const { output, opened } = makeOutput();
    output.append("stdout", "hello ");
    output.append("stdout", "world");
    output.append("stderr", "a warning");

    expect(output.overflowed).toBe(false);
    expect(output.stdoutText()).toBe("hello world");
    expect(output.stderrText()).toBe("a warning");
    // The extra `docker exec` a sink costs must not be paid by the overwhelmingly common case.
    expect(opened()).toBe(0);
  });

  it("stops growing in memory once past the cap", () => {
    const { output } = makeOutput();
    // 100x the cap, in cap-sized chunks. Before the ceiling existed this pattern is exactly what
    // walked a string toward V8's limit and killed the process.
    for (let i = 0; i < 100; i++) output.append("stdout", "x".repeat(MAX_INLINE_BYTES));

    expect(output.overflowed).toBe(true);
    expect(output.bytes).toBe(100 * MAX_INLINE_BYTES);
    // What is retained inline is the preview and nothing more, regardless of how much went through.
    expect(output.stdoutText()).toBe("");
    expect(output.overflowNotice().length).toBeLessThan(PREVIEW_BYTES * 2);
  });

  it("saves every byte to the sink, including the chunk that crossed the cap", () => {
    const { output, saved } = makeOutput();
    // The crossing chunk is the subtle one: it is partly under and partly over the cap, so trimming
    // it at the boundary would silently drop bytes from the file too — the one place they survive.
    const head = "A".repeat(MAX_INLINE_BYTES - 10);
    const crossing = "B".repeat(500);
    const after = "C".repeat(1000);
    output.append("stdout", head);
    output.append("stdout", crossing);
    output.append("stdout", after);

    expect(saved()).toBe(head + crossing + after);
    expect(output.bytes).toBe(head.length + crossing.length + after.length);
  });

  it("keeps stdout and stderr in arrival order in the saved file", () => {
    const { output, saved } = makeOutput();
    output.append("stdout", "1".repeat(MAX_INLINE_BYTES));
    output.append("stderr", "E");
    output.append("stdout", "2");

    // The file is what a person would have seen scrolling past, not stdout-then-stderr.
    expect(saved().endsWith("E2")).toBe(true);
  });

  it("shows a head preview and points the agent at the file", () => {
    const { output } = makeOutput();
    output.append("stdout", "START-MARKER\n" + "z".repeat(MAX_INLINE_BYTES * 2));
    const notice = output.overflowNotice();

    expect(notice).toContain("Output too large");
    expect(notice).toContain("/tmp/paodo-exec/test.output");
    // The agent needs to know the path is queryable, or a path is just a dead end it will ignore.
    expect(notice).toContain("tail -n 200");
    expect(notice).toContain("START-MARKER");
    expect(notice.trimEnd().endsWith("...")).toBe(true);
  });

  it("admits when the saved file was capped rather than claiming the full output", () => {
    const { output } = makeOutput({ truncated: true, limit: 1024 });
    output.append("stdout", "y".repeat(MAX_INLINE_BYTES * 2));

    expect(output.overflowNotice()).toContain("saved file itself was capped");
  });

  it("closes the sink only when one was opened", () => {
    const quiet = makeOutput();
    quiet.output.append("stdout", "small");
    quiet.output.close();
    expect(quiet.isClosed()).toBe(false);

    const loud = makeOutput();
    loud.output.append("stdout", "x".repeat(MAX_INLINE_BYTES * 2));
    loud.output.close();
    expect(loud.isClosed()).toBe(true);
  });
});

describe("formatOutputBytes", () => {
  it("renders the units the truncation notice reports in", () => {
    expect(formatOutputBytes(512)).toBe("512B");
    expect(formatOutputBytes(30_101)).toBe("29.4KB");
    expect(formatOutputBytes(1_288_895)).toBe("1.2MB");
  });
});

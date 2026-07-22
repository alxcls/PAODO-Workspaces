// parseSseStream: parses data frames, reassembles frames split across chunk
// boundaries, and skips malformed/non-data lines without stopping.

import { describe, it, expect } from "vitest";
import { parseSseStream } from "./sse";

// Builds a ReadableStream that emits the given strings as separate chunks, so tests can
// exercise the across-chunk line buffering the parser has to handle.
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("parseSseStream", () => {
  it("parses multiple data frames from one chunk", async () => {
    const events = await collect(parseSseStream(streamFrom([`data: {"type":"a"}\n\ndata: {"type":"b"}\n\n`])));
    expect(events).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    const events = await collect(parseSseStream(streamFrom([`data: {"ty`, `pe":"a"}\n\n`])));
    expect(events).toEqual([{ type: "a" }]);
  });

  it("skips malformed data lines and keeps going", async () => {
    const events = await collect(parseSseStream(streamFrom([`data: not json\n\ndata: {"type":"ok"}\n\n`])));
    expect(events).toEqual([{ type: "ok" }]);
  });

  it("ignores lines without the data: prefix", async () => {
    const events = await collect(parseSseStream(streamFrom([`: comment\n\nevent: foo\n\ndata: {"type":"ok"}\n\n`])));
    expect(events).toEqual([{ type: "ok" }]);
  });

  // The server sends `: ping` comment frames on an interval to stop proxies dropping a stream that
  // has gone quiet (see lib/agent/sse.ts). They land in arbitrary places — including between the
  // halves of a data frame — and must be invisible to the consumer.
  it("ignores keepalive pings interleaved between data frames", async () => {
    const events = await collect(
      parseSseStream(streamFrom([`: ping\n\n`, `data: {"type":"a"}\n\n`, `: ping\n\n`, `data: {"type":"b"}\n\n`])),
    );
    expect(events).toEqual([{ type: "a" }, { type: "b" }]);
  });

  it("does not let a ping corrupt a data frame split across chunks", async () => {
    const events = await collect(parseSseStream(streamFrom([`: ping\n\ndata: {"ty`, `pe":"a"}\n\n: ping\n\n`])));
    expect(events).toEqual([{ type: "a" }]);
  });
});

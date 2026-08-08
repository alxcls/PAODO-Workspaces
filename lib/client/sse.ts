// Parses a Server-Sent-Events response body into typed events. Producers emit each event as
// a single `data: <json>\n\n` frame (see lib/api/workspaceRunStream.ts and the chat route), so the
// transport contract is: split on newlines, keep the trailing partial line buffered across
// chunks, take only `data: `-prefixed lines, JSON.parse the remainder, and silently skip any
// malformed line. Generic over the event payload so each consumer names its own union.

export async function* parseSseStream<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        yield JSON.parse(line.slice(6)) as T;
      } catch {
        /* skip malformed lines */
      }
    }
  }
}

// Drives the agent's agentic loop: streams every model turn, collecting text tokens
// and tool-call chunks simultaneously, then dispatches tools and loops until a turn
// arrives with neither native nor inline tool calls.
// Set DEBUG=1 in the environment to enable verbose tool call logging.
import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { buildTools } from "./tools";
import { getWsForWorkspace } from "../infra/wsHub";
import { createLogger } from "../infra/logger";

const log = createLogger("agent");

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "error"; message: string }
  | { type: "limit_reached" }
  | { type: "done" };

type AnyTool = { invoke: (args: Record<string, unknown>) => Promise<unknown> };
type ResolvedToolCall = { id: string; name: string; args: Record<string, unknown> };

// Newer models return content as an array of typed blocks instead of a plain string.
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) return (block as { text: string }).text;
        return "";
      })
      .join("");
  }
  return "";
}

const MAX_RESULT_CHARS = 10_000;

async function invokeTool(tool: AnyTool, args: Record<string, unknown>): Promise<string> {
  const result = await tool.invoke(args);
  const str = String(result);
  return str.length > MAX_RESULT_CHARS
    ? str.slice(0, MAX_RESULT_CHARS) + `\n\n[output truncated — ${str.length} chars total, showing first ${MAX_RESULT_CHARS}]`
    : str;
}

export async function* runAgent(
  messages: BaseMessage[],
  userInput: string,
  workspaceDir: string,
  workspaceId: string,
  { signal, maxIterations = 30 }: { signal?: AbortSignal; maxIterations?: number } = {},
): AsyncGenerator<AgentEvent> {
  const wlog = log.child({ workspaceId });
  const { modelWithTools, model, toolMap } = buildTools(workspaceId, workspaceDir);
  const typedToolMap = toolMap as Record<string, AnyTool>;
  const socket = getWsForWorkspace(workspaceId);

  messages.push(new HumanMessage(userInput));
  wlog.info({ maxIterations }, "agent run started");

  let iterations = 0;
  try {
    while (true) {
      if (iterations >= maxIterations) {
        wlog.warn({ iterations }, "agent loop limit reached");
        yield { type: "limit_reached" };
        wlog.info("limit synthesis started");
        try {
          const synthMessages = [
            ...messages,
            new HumanMessage(
              "You have reached the maximum number of steps. Briefly summarize what you accomplished and what still needs to be done. Do not attempt any tool calls."
            ),
          ];
          const synthStream = await model.stream(synthMessages, { signal });
          let synthText = "";
          for await (const chunk of synthStream as AsyncIterable<AIMessageChunk>) {
            const text = contentToText(chunk.content);
            if (text) {
              synthText += text;
              yield { type: "token", content: text };
            }
          }
          if (synthText) messages.push(new AIMessage(synthText));
          wlog.info({ chars: synthText.length }, "limit synthesis done");
        } catch (err) {
          wlog.error({ err }, "limit synthesis failed");
        }
        yield { type: "done" };
        break;
      }
      iterations++;
      // Stream one model turn. Tool-call chunks are accumulated by their index field
      // and reconstructed into complete calls after the stream ends.
      // Tokens are buffered and only emitted after the stream ends, when we know there
      // are no tool calls (i.e. the text is the final response, not an intermediate turn).
      type PartialTC = { id: string; name: string; args: string };
      const partials: PartialTC[] = [];
      let fullText = "";

      const t0 = Date.now();
      const stream = await modelWithTools.stream(messages, { signal });
      let ttftMs: number | null = null;
      for await (const chunk of stream as AsyncIterable<AIMessageChunk>) {
        if (ttftMs === null) ttftMs = Date.now() - t0;
        const text = contentToText(chunk.content);
        if (text) {
          fullText += text;
        }
        for (const tcc of chunk.tool_call_chunks ?? []) {
          const idx = tcc.index ?? 0;
          if (!partials[idx]) partials[idx] = { id: "", name: "", args: "" };
          if (tcc.id)   partials[idx].id    = tcc.id;
          if (tcc.name) partials[idx].name += tcc.name;
          if (tcc.args) partials[idx].args += tcc.args;
        }
      }
      const streamMs = Date.now() - t0;
      wlog.debug({ iteration: iterations, ttftMs, streamMs }, "model stream timing");

      const toolCalls: ResolvedToolCall[] = partials
        .filter((p) => p.name)
        .map((p, i) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(p.args || "{}"); } catch { /* leave empty */ }
          return { id: p.id || `tc_${i}_${Date.now()}`, name: p.name, args };
        });

      if (!toolCalls.length) {
        // Final text response — emit the buffered text now that we know no tool calls follow.
        if (fullText) yield { type: "token", content: fullText };
        messages.push(new AIMessage(fullText));
        wlog.info("agent run done");
        yield { type: "done" };
        break;
      }

      // Deduplicate: keep only the last of any calls with identical name+args.
      // Done before pushing the AIMessage so every tool_call_id gets a ToolMessage.
      const seen = new Map<string, number>();
      toolCalls.forEach((tc, i) => seen.set(`${tc.name}:${JSON.stringify(tc.args)}`, i));
      const activeCalls = toolCalls.filter((tc, i) => seen.get(`${tc.name}:${JSON.stringify(tc.args)}`) === i);

      messages.push(new AIMessage({
        content: fullText,
        tool_calls: activeCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
      }));

      // Emit all starts, run all in parallel, then emit results.
      for (const tc of activeCalls) {
        yield { type: "tool_start", name: tc.name, args: tc.args };
        socket?.send(JSON.stringify({ type: "tool_call", name: tc.name, args: tc.args }));
        wlog.debug({ name: tc.name, args: tc.args }, "tool call");
      }

      const settled = await Promise.all(
        activeCalls.map(async (tc) => {
          const tool = typedToolMap[tc.name];
          const toolStart = Date.now();
          const resultStr = tool
            ? await invokeTool(tool, tc.args).catch((err) => `Error: ${String(err)}`)
            : `Error: unknown tool "${tc.name}"`;
          wlog.debug({ name: tc.name, toolMs: Date.now() - toolStart }, "tool timing");
          return { tc, resultStr };
        })
      );

      for (const { tc, resultStr } of settled) {
        yield { type: "tool_result", name: tc.name, result: resultStr };
        if (tc.name !== "execute_command") {
          socket?.send(JSON.stringify({ type: "tool_result_log", name: tc.name, result: resultStr }));
        }
        wlog.debug({ name: tc.name, result: resultStr.slice(0, 200) }, "tool result");
        messages.push(new ToolMessage({ tool_call_id: tc.id, content: resultStr }));
      }
    }
  } catch (err) {
    // Remove any dangling assistant turn with unanswered tool_calls so future
    // requests don't fail with the "tool_call_id must be followed by tool messages" error.
    const last = messages[messages.length - 1];
    if (last instanceof AIMessage && last.tool_calls?.length) messages.pop();
    wlog.error({ err }, "agent run failed");
    yield { type: "error", message: String(err) };
    yield { type: "done" };
  }
}

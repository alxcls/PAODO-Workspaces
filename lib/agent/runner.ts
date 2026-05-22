// Drives the agent's agentic loop: sends messages to the model, dispatches tool calls in parallel,
// feeds results back, and streams token-by-token output for the final response.
// Handles both native tool_calls and inline JSON tool calls emitted by some model versions.
// Set DEBUG=1 in the environment to enable verbose tool call logging.
import { HumanMessage, ToolMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { buildTools } from "./tools";
import { getWsForWorkspace } from "../infra/wsHub";

export type AgentEvent =
  | { type: "token"; content: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "error"; message: string }
  | { type: "done" };

type AnyTool = { invoke: (args: Record<string, unknown>) => Promise<unknown> };

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

function extractInlineToolCall(raw: string): { name: string; parameters: Record<string, unknown> } | null {
  const text = raw.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(text) as { name?: string; parameters?: Record<string, unknown> };
    if (!parsed.name || !parsed.parameters) return null;
    return { name: parsed.name, parameters: parsed.parameters };
  } catch {
    return null;
  }
}

const MAX_RESULT_CHARS = 10_000;
const DEBUG = process.env.DEBUG === "1";
const log = DEBUG ? console.log : () => {};

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
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const { modelWithTools, toolMap } = buildTools(workspaceId, workspaceDir);
  const typedToolMap = toolMap as Record<string, AnyTool>;

  messages.push(new HumanMessage(userInput));

  try {
    let response = await modelWithTools.invoke(messages, { signal });

    while (true) {
      messages.push(response);

      if (!response.tool_calls?.length) {
        const inlineCall = extractInlineToolCall(contentToText(response.content));

        if (inlineCall) {
          const tool = typedToolMap[inlineCall.name];
          if (tool) {
            yield { type: "tool_start", name: inlineCall.name };
            const socket = getWsForWorkspace(workspaceId);
            socket?.send(JSON.stringify({ type: "tool_call", name: inlineCall.name, args: inlineCall.parameters }));
            log(`[tool] ${inlineCall.name}`, inlineCall.parameters);
            const resultStr = await invokeTool(tool, inlineCall.parameters);
            yield { type: "tool_result", name: inlineCall.name, result: resultStr };
            if (inlineCall.name !== "execute_command") {
              socket?.send(JSON.stringify({ type: "tool_result_log", name: inlineCall.name, result: resultStr }));
            }
            log(`[result] ${inlineCall.name}:`, resultStr.slice(0, 200));
            messages.push(
              new ToolMessage({ tool_call_id: `inline_${Date.now()}`, content: resultStr })
            );
            response = await modelWithTools.invoke(messages, { signal });
            continue;
          }
        }

        // Final response — re-invoke in streaming mode so the UI receives tokens as they arrive.
        // We already pushed `response` onto `messages` at the top of the loop (line 71), but the
        // streaming call needs to produce that final turn itself, so we pop it off first and let
        // modelWithTools.stream() regenerate it with token-by-token delivery.
        messages.pop();

        let fullContent = "";
        const stream = await modelWithTools.stream(messages, { signal });
        for await (const chunk of stream) {
          const text = contentToText(chunk.content);
          if (text) {
            fullContent += text;
            yield { type: "token", content: text };
          }
        }

        messages.push(new AIMessage(fullContent));
        yield { type: "done" };
        break;
      }

      // Native tool calls — emit all starts, run all in parallel, then emit results
      const socket = getWsForWorkspace(workspaceId);
      // Deduplicate: if multiple calls to the same tool carry identical args, keep only the last.
      // Prevents redundant back-to-back todo_write (or similar) calls with the same payload.
      const seen = new Map<string, number>();
      response.tool_calls.forEach((tc, i) => {
        if (tc) seen.set(`${tc.name}:${JSON.stringify(tc.args)}`, i);
      });
      const activeCalls = response.tool_calls.filter(
        (tc, i) => tc && seen.get(`${tc.name}:${JSON.stringify(tc.args)}`) === i
      );

      for (const toolCall of activeCalls) {
        yield { type: "tool_start", name: toolCall.name };
        socket?.send(JSON.stringify({ type: "tool_call", name: toolCall.name, args: toolCall.args }));
        log(`[tool] ${toolCall.name}`, toolCall.args);
      }

      const settled = await Promise.all(
        activeCalls.map(async (toolCall) => {
          const tool = typedToolMap[toolCall.name];
          let resultStr: string;
          if (!tool) {
            resultStr = `Error: unknown tool "${toolCall.name}"`;
          } else {
            try {
              resultStr = await invokeTool(tool, toolCall.args as Record<string, unknown>);
            } catch (err) {
              resultStr = `Error: ${String(err)}`;
            }
          }
          return { toolCall, resultStr };
        })
      );

      for (const { toolCall, resultStr } of settled) {
        yield { type: "tool_result", name: toolCall.name, result: resultStr };
        if (toolCall.name !== "execute_command") {
          socket?.send(JSON.stringify({ type: "tool_result_log", name: toolCall.name, result: resultStr }));
        }
        log(`[result] ${toolCall.name}:`, resultStr.slice(0, 200));
        messages.push(new ToolMessage({ tool_call_id: toolCall.id!, content: resultStr }));
      }

      response = await modelWithTools.invoke(messages, { signal });
    }
  } catch (err) {
    // Remove any dangling assistant message with unanswered tool_calls so future
    // requests don't fail with the "tool_call_id must be followed by tool messages" error.
    const last = messages[messages.length - 1];
    if (last instanceof AIMessage && last.tool_calls?.length) {
      messages.pop();
    }
    yield { type: "error", message: String(err) };
    yield { type: "done" };
  }
}

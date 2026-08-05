// Executes one normalized batch of model-requested tools. The runner owns turn ordering and history;
// this module owns invocation, result classification, truncation, and live call-agent link delivery.
import type { Logger } from "pino";
import type { ToolStatus } from "../workspace/usageStore";
import type { CallAgentMeta } from "./tools/agentCall";
import { classifyToolStatus } from "./toolUtils";
import type { ResolvedToolCall } from "./modelTurn";

type AgentCallWithMeta = (
  args: Record<string, unknown>,
  onLink?: (meta: CallAgentMeta) => void,
  callerSignal?: AbortSignal,
) => Promise<{ result: string; meta?: CallAgentMeta }>;

export type RunnerTool = {
  name: string;
  invoke: (args: Record<string, unknown>, config?: { signal?: AbortSignal }) => Promise<unknown>;
  suppressResultNotify?: boolean;
  skipResultCap?: boolean;
  callWithMeta?: AgentCallWithMeta;
};

export type SettledToolCall = {
  tc: ResolvedToolCall;
  resultStr: string;
  meta?: CallAgentMeta;
  status: ToolStatus;
};

export type QueuedToolLink = { name: string; id?: string; meta: CallAgentMeta };

const MAX_RESULT_CHARS = 50_000;

async function invokeTool(tool: RunnerTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const result = String(await tool.invoke(args, { signal }));
  if (tool.skipResultCap || result.length <= MAX_RESULT_CHARS) return result;
  const lastNewline = result.lastIndexOf("\n", MAX_RESULT_CHARS);
  const cut = lastNewline > 0 ? lastNewline : MAX_RESULT_CHARS;
  return result.slice(0, cut) + `\n\n[output truncated — ${result.length} chars total, showing first ${cut}]`;
}

function createLinkQueue() {
  const queue: QueuedToolLink[] = [];
  let wakeUp: (() => void) | null = null;
  let done = false;
  return {
    emit(link: QueuedToolLink) {
      queue.push(link);
      wakeUp?.();
      wakeUp = null;
    },
    settle() {
      done = true;
      wakeUp?.();
      wakeUp = null;
    },
    async *drain(): AsyncGenerator<QueuedToolLink> {
      while (!done || queue.length) {
        while (queue.length) yield queue.shift()!;
        if (done) break;
        await new Promise<void>((resolve) => {
          wakeUp = resolve;
        });
      }
    },
  };
}

export function dispatchTools(
  calls: ResolvedToolCall[],
  tools: Record<string, RunnerTool>,
  signal: AbortSignal | undefined,
  log: Logger,
): { links: AsyncGenerator<QueuedToolLink>; settled: Promise<SettledToolCall[]> } {
  const linkQueue = createLinkQueue();
  const settled = Promise.all(
    calls.map(async (tc): Promise<SettledToolCall> => {
      const tool = tools[tc.name];
      const startedAt = Date.now();
      let resultStr: string;
      let meta: CallAgentMeta | undefined;
      let invocationThrew = false;
      if (tool?.callWithMeta) {
        const result = await tool
          .callWithMeta(tc.args, (value) => linkQueue.emit({ name: tc.name, id: tc.id, meta: value }), signal)
          .catch((err) => {
            invocationThrew = true;
            if (!signal?.aborted) log.warn({ err, name: tc.name }, "tool invocation threw");
            return { result: `Error: ${String(err)}`, meta: undefined };
          });
        resultStr = result.result;
        meta = result.meta;
      } else if (tool) {
        resultStr = await invokeTool(tool, tc.args, signal).catch((err) => {
          invocationThrew = true;
          if (!signal?.aborted) log.warn({ err, name: tc.name }, "tool invocation threw");
          return `Error: ${String(err)}`;
        });
      } else {
        log.warn({ name: tc.name }, "model requested unknown tool");
        resultStr = `Error: unknown tool "${tc.name}"`;
      }

      const toolMs = Date.now() - startedAt;
      const status = classifyToolStatus(resultStr);
      if (tool && status === "error" && !invocationThrew && !signal?.aborted) {
        log.warn({ name: tc.name, toolMs, status }, "tool returned error");
      } else {
        log.debug({ name: tc.name, toolMs, status }, "tool timing");
      }
      return { tc, resultStr, meta, status };
    }),
  ).then((results) => {
    linkQueue.settle();
    return results;
  });

  return { links: linkQueue.drain(), settled };
}

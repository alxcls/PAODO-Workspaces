// Everything DeepSeek requires that no other provider should inherit. Canonical conversation messages
// stay provider-neutral; this module restores its private reasoning at the outbound boundary.
import { AsyncLocalStorage } from "node:async_hooks";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import { replayReasoning } from "./reasoningReplay";
import { THINKING_OFF_EFFORT, type ReasoningEffort } from "../models/llmSelection";

/** Reasoning for one request, keyed by the tool-call id of the turn that produced it. */
type ReasoningLookup = Map<string, string>;

/**
 * Scoped to a single call rather than held on the client, because the object the runner calls is not
 * the one this module builds: bindTools returns a fresh Runnable wrapping the same client, so anything
 * keyed by instance is missed on exactly the calls that matter, while the shared client's fetch would
 * still see a lookup another call had left behind.
 */
const REASONING_SCOPE = new AsyncLocalStorage<ReasoningLookup>();

/**
 * DeepSeek's thinking fields. The OpenAI-compatible `reasoning_effort` has no "none", so switching
 * thinking off is a different field entirely rather than another level.
 *
 * Sending neither is not an option: since 13 Aug 2026 V4-Flash and V4-Pro think by default at "high",
 * so a request that says nothing pays for the most verbose reasoning the model offers.
 */
export function deepseekReasoningConfig(effort: ReasoningEffort): { modelKwargs: Record<string, unknown> } {
  return effort === THINKING_OFF_EFFORT
    ? { modelKwargs: { thinking: { type: "disabled" } } }
    : { modelKwargs: { reasoning_effort: effort } };
}

/** An assistant message as it appears in the request body, once LangChain has converted it. */
type WireMessage = { tool_calls?: Array<{ id?: string }>; reasoning_content?: string };

/**
 * Put each turn's reasoning back on the wire message that produced it.
 *
 * Pairing is by tool-call id — unique, already persisted, and stable across a reload — rather than by
 * position, which a compaction or a dropped turn would silently shift. A body this cannot parse is
 * returned untouched: replay must never be the reason a call fails.
 */
function restoreReasoningContent(body: string, lookup: ReasoningLookup): string {
  let payload: { messages?: WireMessage[] };
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  if (!Array.isArray(payload.messages)) return body;

  let changed = false;
  for (const message of payload.messages) {
    const id = message.tool_calls?.[0]?.id;
    const reasoning = id ? lookup.get(id) : undefined;
    if (reasoning && message.reasoning_content === undefined) {
      message.reasoning_content = reasoning;
      changed = true;
    }
  }
  return changed ? JSON.stringify(payload) : body;
}

/**
 * The fetch seam is where injection happens, because there is nowhere earlier that survives.
 *
 * LangChain's outbound converter copies only function_call, tool_calls and audio off a message's
 * additional_kwargs and drops everything else, so reasoning_content cannot ride on a cloned message
 * the way Mistral's thinking blocks ride in `content`. Here the body is already DeepSeek's own
 * documented shape — a far steadier contract than the SDK's internals.
 */
function deepseekFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const lookup = REASONING_SCOPE.getStore();
    if (!lookup?.size || typeof init?.body !== "string") return inner(input, init);
    return inner(input, { ...init, body: restoreReasoningContent(init.body, lookup) });
  };
}

/** A ChatOpenAI that replays reasoning, wrapping whatever fetch the caller already installed. */
export function createDeepSeekChatModel(fields: ChatOpenAIFields): ChatOpenAI {
  const inner = (fields.configuration?.fetch as typeof fetch | undefined) ?? fetch;
  return new ChatOpenAI({
    ...fields,
    configuration: { ...fields.configuration, fetch: deepseekFetch(inner) },
  });
}

/** What each turn reasoned, addressed by the tool call that turn made. */
function lookupFrom(messages: BaseMessage[]): ReasoningLookup {
  const lookup: ReasoningLookup = new Map();
  for (const message of messages) {
    if (!(message instanceof AIMessage)) continue;
    const id = message.tool_calls?.[0]?.id;
    const reasoning = replayReasoning(message);
    if (id && reasoning) lookup.set(id, reasoning);
  }
  return lookup;
}

/**
 * DeepSeek's outbound adapter: run one call with its own reasoning in scope.
 *
 * The messages go out untouched — unlike Mistral, nothing about a DeepSeek message needs rewriting.
 * Only a field LangChain refuses to carry has to be restored, and that happens in the fetch above,
 * which reads the scope this opens. The lifetime is the call, so nothing can leak into the next one.
 */
export function sendWithDeepSeekReasoning<T>(
  messages: BaseMessage[],
  send: (messages: BaseMessage[]) => Promise<T>,
): Promise<T> {
  return REASONING_SCOPE.run(lookupFrom(messages), () => send(messages));
}

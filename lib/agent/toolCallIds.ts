// Tool-call ids in the one shape every supported provider accepts.
//
// Mistral rejects any tool-call id that is not exactly 9 alphanumeric characters, with a 400
// ("Tool call IDs should be alphanumeric strings with length 9!"). Every other provider is
// permissive and mints its own longer, prefixed ids — `toolu_01…` on Anthropic, `call_…` on OpenAI.
//
// That would be Mistral's own problem except for one thing: a workspace can switch provider
// mid-conversation (the Model block writes llmProvider on the workspace record), and the runner
// replays the WHOLE history on every request. So a conversation built on Anthropic and then pointed
// at Mistral fails on ids it did not create and cannot fix — the model never gets a turn. The
// narrowest shape all five providers accept is therefore the one enforced here, for every provider
// rather than only for Mistral: a history that is portable in one direction only is a trap waiting
// for the next switch.
//
// The shape is NOT written here. It is the intersection of what each provider declares in
// lib/agent/buildModel.ts (TOOL_CALL_ID_CONSTRAINT), so the reason it is 9 alphanumerics lives
// beside the provider that demands it, and a provider added with an irreconcilable demand fails at
// module load rather than at request time.
//
// ── INVARIANT ────────────────────────────────────────────────────────────────────────────────────
// A tool-call id is a WITHIN-ARRAY correlation key and must never become a durable key. This pass
// rewrites ids in the live array the conversation store owns, and persist() writes those rewritten
// ids back — so anything outside the message array that remembered an old id would silently stop
// matching. Nothing does today, and that is a property to preserve, not a coincidence to rely on:
// messageSerialization.ts and compact.ts both pair ids within the array they were handed, and the
// usage ledger keys tool rows by turn_id/position (lib/usage/rows.ts). Key by either of those, or by
// name+args, before reaching for a call id.
//
// ── WHY GLOBAL REWRITING, AND HOW TO LEAVE ───────────────────────────────────────────────────────
// Two alternatives were weighed and rejected, both of which keep stored history provider-neutral by
// translating at the provider boundary instead:
//
//   * Translate outbound, map back inbound. Needs a STABLE per-conversation id map, persisted,
//     because tool results reference those ids on every later turn. That buys a side table, a
//     migration, and a failure mode where a lost map makes a conversation unreplayable.
//   * Translate outbound by hashing the native id (stateless, no map). Works, but then what the
//     provider saw differs from what we stored on EVERY request — strictly worse on the one thing
//     boundary translation was supposed to protect, which is traceability.
//
// Global rewriting costs the link between a stored id and the provider's own record of that call
// (nothing in this app consumes that link today), and it fixes the app's id format at the tightest
// demand any provider makes. In exchange: no map, no migration, idempotent, and conversations
// persisted before this existed are repaired by the act of running them.
//
// THE EXIT, if TOOL_CALL_ID_CONSTRAINT ever throws — i.e. a provider arrives whose demand cannot be
// reconciled (it requires a prefix, or a length past Mistral's 9): stop enforcing one canonical
// shape, and apply deterministic per-provider outbound hashing to the offending provider only,
// inside its `build`. Accept that its ids then differ per request. Do NOT widen the constraint to
// make the intersection non-empty — that produces ids Mistral rejects, which is the bug this module
// exists to prevent.
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { TOOL_CALL_ID_CONSTRAINT } from "./buildModel";
import { satisfiesConstraint } from "./toolCallIdConstraint";

const ALPHABET = TOOL_CALL_ID_CONSTRAINT.alphabet;
// The shortest id the constraint allows. Length is not a security property here (see newToolCallId),
// so there is nothing to gain from a longer one — and a provider that caps length is likelier than
// one that demands more of it.
const ID_LENGTH = TOOL_CALL_ID_CONSTRAINT.minLength;

/** Whether an id is already in the shape every provider accepts. */
export function isPortableToolCallId(id: string): boolean {
  return satisfiesConstraint(id, TOOL_CALL_ID_CONSTRAINT);
}

/**
 * A fresh portable id, re-rolled until it is absent from `taken` (which it then joins).
 *
 * The modulo bias across the alphabet is deliberate and harmless: this correlates a call with its
 * result inside one conversation and is never a secret, so uniformity buys nothing. Collisions are
 * what matter, and `taken` rules them out within a history outright.
 */
export function newToolCallId(taken: Set<string> = new Set()): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
    let id = "";
    for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/**
 * Rewrites every non-portable tool-call id in `messages` to a portable one, IN PLACE.
 *
 * Both halves of a pair move together — an AIMessage's `tool_calls[].id` and the `tool_call_id` of
 * the ToolMessage answering it. The mapping is keyed by the OLD id rather than applied per
 * occurrence, which is what preserves pairing: minting an id at each site would silently detach every
 * tool result from its call, and the damage would surface as a provider 400 about unanswered tool
 * calls, far from here.
 *
 * Already-portable ids are kept. That makes this a no-op for a Mistral-only conversation and makes a
 * second pass over the same array change nothing — the idempotence is what allows it to run at the
 * top of every single run without accumulating churn.
 */
export function normalizeToolCallIds(messages: BaseMessage[]): void {
  // Seed with the ids being KEPT, so a freshly minted id can never collide with one already in this
  // history and hijack another call's result.
  const taken = new Set<string>();
  for (const message of messages) {
    if (message instanceof AIMessage) {
      for (const call of message.tool_calls ?? []) {
        if (call.id && isPortableToolCallId(call.id)) taken.add(call.id);
      }
    }
  }

  const rewritten = new Map<string, string>();
  const portable = (old: string): string => {
    if (isPortableToolCallId(old)) return old;
    let next = rewritten.get(old);
    if (!next) {
      next = newToolCallId(taken);
      rewritten.set(old, next);
    }
    return next;
  };

  for (const message of messages) {
    if (message instanceof AIMessage) {
      for (const call of message.tool_calls ?? []) {
        if (call.id) call.id = portable(call.id);
      }
    } else if (message instanceof ToolMessage && message.tool_call_id) {
      // An orphaned ToolMessage — one no AIMessage claims — is rewritten too. It is already broken,
      // but a single long id left anywhere in the array rejects the entire request, not just its own
      // message, so leaving it behind would defeat the whole pass.
      message.tool_call_id = portable(message.tool_call_id);
    }
  }
}

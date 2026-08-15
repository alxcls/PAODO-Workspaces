// The vocabulary for "this run cannot reach a working model", in one place.
//
// There are now four ways a run dies before or during its first model call, and they were on their
// way to being hand-listed in five modules — runner.ts's AgentErrorCode union, modelTurn.ts's
// synthesize path, executeSkill.ts's CALLEE_TERMINAL_CODES, agentCall.ts's do-not-retry branch, and
// lib/skills/types.ts's result union. A code added to four of the five is a sub-agent that retries a
// failure nothing can fix, forever, at cost. So the list lives here and those modules consume it.
//
// TWO OF THESE ARE KNOWN WITHOUT ASKING THE PROVIDER, and that is the distinction worth preserving:
//
//   PROVIDER_UNAVAILABLE  — the workspace's provider is switched off in this deployment.
//   PROVIDER_KEY_MISSING  — it is switched on, but nobody has entered its API key.
//
// Both leave the workspace unable to run, and after a purge both look identical from the key store
// (no key either way) — which is exactly why they must not share a message. "Add a key in Settings"
// sent to someone whose provider is switched off points them at a form that will not list it; "this
// provider is switched off" sent to someone who simply never pasted a key hides a 10-second fix.
//
// The other two are the provider's own verdict, classified from its wording next door:
//
//   PROVIDER_CREDIT_EXHAUSTED — the account has no money (./providerCreditFailure.ts).
//   PROVIDER_KEY_INVALID      — the key was sent and refused (./providerAuthFailure.ts).
import { PROVIDER_CREDIT_EXHAUSTED_CODE } from "./providerCreditFailure";
import { PROVIDER_KEY_INVALID_CODE } from "./providerAuthFailure";

export const PROVIDER_KEY_MISSING_CODE = "PROVIDER_KEY_MISSING" as const;
export const PROVIDER_UNAVAILABLE_CODE = "PROVIDER_UNAVAILABLE" as const;

export { PROVIDER_CREDIT_EXHAUSTED_CODE, PROVIDER_KEY_INVALID_CODE };

/**
 * Every provider-level failure no retry can fix.
 *
 * A caller that sees one of these must stop, not back off — the condition is a configuration or
 * billing fact that will still be true on the next attempt, and each retry is another failed run in
 * the transcript (and, for credit exhaustion, another call the provider bills for refusing).
 */
export const TERMINAL_PROVIDER_CODES = [
  PROVIDER_CREDIT_EXHAUSTED_CODE,
  PROVIDER_KEY_INVALID_CODE,
  PROVIDER_KEY_MISSING_CODE,
  PROVIDER_UNAVAILABLE_CODE,
] as const;

export type TerminalProviderCode = (typeof TERMINAL_PROVIDER_CODES)[number];

export function isTerminalProviderCode(code: string | undefined): code is TerminalProviderCode {
  return TERMINAL_PROVIDER_CODES.some((terminal) => terminal === code);
}

/**
 * Whether a run can even be attempted, checked before the first request.
 *
 * Returns null when the run may proceed. Ordering matters: a switched-off provider is reported as
 * such even though its key was purged too, because "switched off" is the cause and "no key" is only
 * its consequence — reporting the consequence would send the operator to a form that cannot show the
 * provider, to fix something that is not broken.
 */
export function preflightProviderFailure(
  config: { provider: string; model: string; apiKey?: string },
  offeredProviders: readonly string[],
): { code: TerminalProviderCode; message: string } | null {
  if (!config.provider) {
    return {
      code: PROVIDER_UNAVAILABLE_CODE,
      message:
        "This deployment offers no LLM providers — every supported provider is switched off in its " +
        "configuration. No workspace can run until at least one is switched back on.",
    };
  }
  if (!offeredProviders.includes(config.provider)) {
    return {
      code: PROVIDER_UNAVAILABLE_CODE,
      message:
        `This workspace is set to ${config.provider}, which this deployment has switched off ` +
        `(${config.provider.toUpperCase()}_AVAILABLE=false). Its stored API key was deleted when it was ` +
        `withdrawn. Pick another provider for this workspace, or switch ${config.provider} back on.`,
    };
  }
  if (!config.apiKey) {
    return {
      code: PROVIDER_KEY_MISSING_CODE,
      message:
        `No API key set for ${config.provider}. This run stopped before contacting it — add the key ` +
        `in Settings → Provider API keys, then send the message again.`,
    };
  }
  return null;
}

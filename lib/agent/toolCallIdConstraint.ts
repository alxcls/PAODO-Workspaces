// What a provider demands of an INBOUND tool-call id, and how several such demands reconcile into
// the one shape the app can safely store.
//
// This models VALIDATION, not minting. What a provider mints in its own responses is its business.
// What it will ACCEPT when a conversation built elsewhere is replayed to it is what constrains the
// whole app, because a workspace can switch provider mid-conversation and the runner replays the
// entire history every turn — see lib/agent/toolCallIds.ts for why that makes the constraint global
// rather than Mistral's private problem.
//
// Expressed as an alphabet plus a length range rather than a regex, deliberately: the app has to
// INTERSECT several providers' demands and generate one id that satisfies all of them at once.
// Regexes can be tested but not intersected; character sets and ranges can be both.
//
// KNOWN LIMIT — a provider that requires a fixed PREFIX (`call_…`) cannot be described by this type.
// That is not an oversight to route around by widening the alphabet: an id shaped to satisfy such a
// provider could not simultaneously satisfy Mistral's 9-character ceiling, so the honest response is
// the exit path documented in toolCallIds.ts, not a richer constraint type. This limit is recorded
// here so the gap surfaces at the type when someone tries to declare one.

/** Every alphanumeric character — the widest alphabet any provider is known to accept today. */
export const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export interface ToolCallIdConstraint {
  /** Who demanded this. Used only to name both sides when two demands cannot be reconciled. */
  name: string;
  /** Every character this provider accepts inside an id. */
  alphabet: string;
  minLength: number;
  maxLength: number;
}

/**
 * The shape the app would use if no provider demanded anything.
 *
 * The 9 is not a vendor claim — it is this app's own floor, chosen so that removing the provider
 * that forces exactly 9 does not silently change the ids the app generates. The ceiling is loose on
 * purpose: it exists to be narrowed by a declaration, not to assert what any vendor permits.
 */
export const BASELINE_CONSTRAINT: ToolCallIdConstraint = {
  name: "app baseline",
  alphabet: ALPHANUMERIC,
  minLength: 9,
  maxLength: 64,
};

/** Whether an id satisfies a constraint — the single definition of "portable", derived not written. */
export function satisfiesConstraint(id: string, constraint: ToolCallIdConstraint): boolean {
  if (id.length < constraint.minLength || id.length > constraint.maxLength) return false;
  for (const character of id) if (!constraint.alphabet.includes(character)) return false;
  return true;
}

function describe(constraint: ToolCallIdConstraint): string {
  const length =
    constraint.minLength === constraint.maxLength
      ? `exactly ${constraint.minLength}`
      : `${constraint.minLength}–${constraint.maxLength}`;
  return `${constraint.name} (${length} chars from a ${constraint.alphabet.length}-symbol alphabet)`;
}

function intersect(a: ToolCallIdConstraint, b: ToolCallIdConstraint): ToolCallIdConstraint {
  const alphabet = [...a.alphabet].filter((character) => b.alphabet.includes(character)).join("");
  const minLength = Math.max(a.minLength, b.minLength);
  const maxLength = Math.min(a.maxLength, b.maxLength);

  // THIS is the whole point of the type. Two providers whose demands do not overlap mean no single
  // stored id can satisfy both, and the app's approach — one canonical shape for every provider —
  // has no answer. Failing here fails at module load, i.e. on the branch that adds the offending
  // provider, naming both sides. The alternative is a 400 in production on a conversation that
  // worked yesterday, in history nobody touched. See the exit path in lib/agent/toolCallIds.ts.
  if (!alphabet || minLength > maxLength) {
    throw new Error(
      `no tool-call id shape satisfies both ${describe(a)} and ${describe(b)}. ` +
        `A single canonical id can no longer serve every provider — see the exit path documented in ` +
        `lib/agent/toolCallIds.ts before widening either constraint.`,
    );
  }

  return { name: `${a.name} ∩ ${b.name}`, alphabet, minLength, maxLength };
}

/**
 * The one id shape that satisfies every demand, or a throw naming the two that cannot be reconciled.
 *
 * Order-independent: intersection is commutative and associative, so the result does not depend on
 * the order providers happen to be declared in.
 */
export function narrowestConstraint(demands: readonly ToolCallIdConstraint[]): ToolCallIdConstraint {
  return demands.reduce(intersect, BASELINE_CONSTRAINT);
}

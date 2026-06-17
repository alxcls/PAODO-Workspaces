# ADR — Testing strategy: invariants and pure primitives, integration via E2E

Status: Accepted

## Context

The unit suite is deliberately small relative to the size of the codebase. Read as a coverage number that looks like "undertested," but the existing tests follow a consistent, intentional philosophy that was never written down. This ADR records it so the approach is enforced as a norm rather than mistaken for a gap to be carpet-filled with low-value tests.

## Decision

Testing is **risk-targeted, not coverage-targeted.** The rules:

1. **Unit-test the gnarly, regression-prone invariant** — state machines, atomicity/ordering guarantees, retry/counter bookkeeping, security primitives. Pin the invariant and the bug class it guards, not the implementation detail.
2. **Push hard logic into pure functions and test the function.** Prefer extracting a testable primitive over testing through React/HTTP/IO glue.
3. **Cover integration and wiring (UI glue, happy-path request flow) with Playwright E2E**, not unit tests.
4. **Prefer fakes and dependency injection over mocks.** When mocks are unavoidable, comment why.
5. **Open every test file with a comment stating the invariant under test and the bug class it guards.**
6. **Two exceptions get a unit test regardless of how trivial the wrapper looks**, because E2E only exercises happy paths and won't catch their failure:
   - **API-route authorization and input validation** (auth checks, ownership scoping, rejection of malformed input).
   - **Security-sensitive tool wrappers actually invoking their guard** — the tool must be shown to call the guard, not just that the guard works in isolation.

Coverage reporting exists for *visibility* — to tell genuinely-trivial untested files apart from quietly-important ones — and is not gated on a percentage threshold.

## Consequences

- **Enables:** a small, fast, high-signal suite where each test documents a real failure mode; low maintenance cost (few mocks, little glue testing); a clear answer to "should this get a test?" (does it carry an invariant, or fall under exception 6?).
- **Costs / risks:** large swaths of glue (UI hooks, most API routes, most tool wrappers) have no unit test and rely on E2E, which only runs happy paths and needs a live LLM + Docker. The named exceptions exist precisely because that reliance is unsafe there; the rest is an accepted trade.
- **Operational:** the unit tier stays portable (no Docker) and fast; integration and E2E tiers run where their dependencies exist.

## Alternatives considered

- **Coverage-threshold gate:** rejected. It forces low-value tests on trivial glue, inflating maintenance cost and diluting signal, without protecting the invariants that actually break.
- **Unit-test everything including hooks/routes:** rejected as the default — duplicates what E2E covers for glue and couples tests to implementation. Adopted *only* for the two security-relevant exceptions where E2E coverage is insufficient.
- **Leave the philosophy implicit:** rejected — a future contributor sees a low coverage number and either ignores testing or carpet-fills it, both of which erode the signal-to-noise ratio.

## Notes

- Tiers: a fast unit tier (no Docker), a Docker-backed integration tier, and a live-LLM/Docker Playwright E2E tier. See `vitest.config.ts`, `vitest.integration.config.ts`, `playwright.config.ts`.

# ADR — System prompt rebuilt on every chat request

Status: Accepted

## Context

Each workspace has an `AGENTS.md` file injected into the agent's system prompt to let users customize agent behavior (persona, constraints, project-specific instructions). Users should be able to edit this file and see effects immediately, without restarting the server or clearing the session.

## Decision

The system prompt is assembled from disk (`lib/agent/systemPrompt.ts`) on every call to the chat route (`app/api/workspaces/[id]/chat/route.ts`), not cached. `AGENTS.md` is read fresh each time via `fs.readFileSync`.

## Consequences

- `AGENTS.md` changes take effect on the very next message — no restart required.
- Negligible extra I/O per request (one small file read).
- The system prompt occupies a fixed `messages[0]` slot and is overwritten on every request, so the conversation array never grows from it.

## Alternatives considered

- Cache the prompt at session start: simpler but requires a restart or explicit session reset to pick up `AGENTS.md` changes.
- Store the prompt as the first message in the history array: persists unintentionally and causes drift when the file is edited mid-session.

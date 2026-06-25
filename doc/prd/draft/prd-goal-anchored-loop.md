# PRD — Goal-Anchored Agentic Loop

**Status:** Draft  
**Author:** alxcls  
**Related:** [VISION.md](../../VISION.md), [agent-loop.md](../../agent-loop.md), [prd-agent-loop-control.md](../accepted/prd-agent-loop-control.md), [prd-scheduled-agent-triggers.md](prd-scheduled-agent-triggers.md)

---

## Problem

The agent runs as a pure ReAct loop that exits the moment it stops calling tools — with no check that it actually achieved what it was asked. A human watching the chat catches a wrong result; an unattended run (scheduled trigger, agent-to-agent call, API) does not. Unattended operation is the goal of the app, so work currently ships with nobody verifying it.

The loop also has no stable reference to judge against: "is this done / good enough?" is meaningless without a fixed success criterion — which is why a self-critic on its own is unreliable.

## Approach

**Stay pure ReAct — add tools, not loops.** The depth (set a goal, plan, replan, self-critique) is opt-in via tools the agent reaches for when the task warrants. A trivial task skips them and runs as plain ReAct; a complex one uses them. The engine in [runner.ts](../../../lib/agent/runner.ts) is unchanged: think → call tool → see result → repeat until no tool calls.

- **Goal** — `set_goal` tool. Writes the goal into the conversation (the agent's working copy); the runner **snapshots it once** on first call. That snapshot is the fixed reference the critic judges against, and the agent cannot redefine it mid-run.
- **Plan / replan** — no new tool. This is the existing `todo_write`; replan is the agent rewriting its todos. A line in the system prompt nudges "set a goal, plan it as todos."
- **Critique** — `request_critique` tool, signal-only like `compact_context`. The agent calls it; the **runner** spawns a fresh, independent critic agent, feeds it the goal snapshot + the run's git diff, lets it run tests in the terminal, and returns **red/green + reason** as the tool result.
- **Retry is free.** On red, the agent sees the reason in the tool result and keeps working — ordinary ReAct looping. No retry counter; the existing `maxIterations` is the cap.

## The critic

The critic is a **separate, fresh agent** — not the working agent grading itself (that just confirms itself). It is grounded by **evidence the runner feeds it**, not by the working agent's self-report:

- **Input:** the frozen goal snapshot + the **diff of the current run** (what actually changed), from the workspace versioning history (see [prd-workspace-git-versioning.md](prd-workspace-git-versioning.md)).
- **Tools:** it can use the terminal to **verify** — run tests, inspect files — so it confirms behavior, not just reads the diff.
- **Mutations are discarded, not forbidden.** Tests legitimately write (build artifacts, temp files), so the critic may write. The runner discards whatever it did afterward via `git reset --hard <run-end-commit> && git clean -fd` (or a `git worktree` copy for concurrent safety), restoring the exact state it judged. The critic never persists changes into the judged state or the history.
- **Output:** `red`/`green` **+ a reason**. Green → the working agent can finish. Red → the reason flows back as the tool result; the working agent fixes and retries.
- **Bounded:** its own step cap so the critic cannot loop forever.

## Goals

- Give a run an explicit, frozen **goal** as a stable reference for self-assessment.
- Let the agent **self-critique against the goal** via a fresh, test-running critic, and naturally retry on red — within the one ReAct loop.
- Keep all of it **opt-in and available on every path** (interactive and unattended), with no parallel loop.
- Provide an **optional enforcement guard** for unattended paths where skipping the critique is unsafe.

## Non-goals

- A rigid `goal→plan→replan→critic` state machine, or any new control flow in the runner beyond the goal snapshot, the critic invocation, and the optional exit guard.
- A separate retry counter — retry rides on `maxIterations`.
- Cost or time budgets (a non-goal of loop control; the step cap still applies).
- Multi-goal or sub-goal hierarchies.
- A read-only critic (it must be able to run tests; isolation comes from discarding its changes, not from forbidding them).

## User stories

- As a workspace owner, I want the agent to state a goal and have a fresh critic check the work against it — running the tests — before finishing.
- As a workspace owner, I want a red verdict to make the working agent keep going (with the reason) rather than stop, up to the step cap.
- As a workspace owner running unattended jobs, I want to require a green verdict before a run can finish, so a scheduled job can't silently ship a wrong result.
- As a calling agent, I want a verified result (or an explicit "goal not met") so I can trust what comes back.

## Requirements

### Must have

- **`set_goal` tool** — records the goal in the conversation; the runner captures a one-time **snapshot** (a single variable) on first call. Later calls update the agent's working copy but never the snapshot.
- **`request_critique` tool (signal-only)** — triggers the critic; returns its `red`/`green` + reason as the tool result.
- **Critic agent** — fresh and independent, fed { goal snapshot + run git diff }, may use the terminal to run tests, **bounded by its own step cap**, returns red/green + reason.
- **Discard critic mutations** — after the critic finishes, restore the workspace to the run-end commit (`git reset --hard && git clean -fd`, or a worktree copy), so nothing it did persists into the judged state or history. Serialize per workspace (existing single-instance state) to avoid collision.
- **Retry via ReAct** — red flows back as a tool result; the agent reasons and acts again. Bounded by the existing `maxIterations`, not a new counter.
- **Plan/replan via `todo_write`** — no new tool; a system-prompt line nudges goal-then-todos.
- **Observable** — a `goal` and a `critique_verdict` event added to the `AgentEvent` union so the goal and each verdict stream to the UI.

### Nice to have

- **Unattended exit guard** — on unattended paths (schedule, A2A, API), block the no-tool-calls exit ([runner.ts:293](../../../lib/agent/runner.ts#L293)) unless the last critique was `green`; on the step cap with no green, escalate via the `needs_input` path with the last reason, mirroring `limit_reached` degradation. Off for interactive runs (the human is the check).
- Per-workspace default verification policy / critic step cap in settings.
- Surface the goal and final verdict in the monitoring dashboard.

## Dependencies

- **Workspace versioning** ([prd-workspace-git-versioning.md](prd-workspace-git-versioning.md)) — provides the per-run snapshots the critic diffs against and the mechanism for discarding critic mutations. (Agent-facing browse and roll-back shipped — see [prd-agent-version-history.md](../accepted/prd-agent-version-history.md).)

## Open questions

- Should `set_goal` be agent-authored only, or also settable explicitly via schedule/skill input?
- `git reset --hard` (simplest, relies on per-workspace serialization) vs. `git worktree` (concurrency-safe, slightly more plumbing) for critic isolation — start with which?
- Should the unattended exit guard be on by default for unattended paths, or opt-in per workspace?

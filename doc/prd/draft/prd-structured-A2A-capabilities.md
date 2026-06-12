# PRD — Structured A2A Capabilities

**Status:** Draft  
**Author:** @alxcls  
**Related:** [prd-agent-network.md](../accepted/prd-agent-network.md), [prd-shared-drives.md](prd-shared-drives.md)

---

## Problem

Agents in the network talk to each other in free-form text. The calling agent
guesses what to ask and how to phrase it; the answering agent guesses what to
reply and in what shape. Both guesses fail regularly:

- Callers invent or omit information the other agent needs.
- Responders reply with friendly prose instead of usable data, or make values up.

There is no agreement between the two sides about what a request or an answer
should look like, so multi-agent workflows are unreliable even when the network
is wired correctly.

## Goals

- Every workspace can declare **skills**: the named things other agents may ask
  it to do, each with clearly defined inputs and a promised answer format.
- The platform **guarantees the agreement on both sides**: a request is checked
  before the answering agent sees it, and the answer is checked before the
  calling agent receives it. Bad answers are sent back for correction a limited
  number of times.
- Calling agents can **discover** what their connected agents offer — skill
  names, what to provide, and what they will get back — so they fill in
  requests without guessing.
- Skills are **plain files inside the workspace**, so an agent can create and
  update its own skills with the tools it already has, without waiting for a
  human.
- Structured calls **replace** free-form agent-to-agent messages entirely.

## Non-goals

- Connecting to agents outside the platform, or compatibility with external
  agent-to-agent protocols.
- New permissions or authentication — who may call whom is still decided by the
  existing agent network connections.
- Editing skills through the graph UI — skills belong to the workspace and its
  agent, not to the network editor.
- Versioning of skills, or sharing one skill across workspaces.
- Keeping the old free-form message option as a fallback — it is removed.
- Re-running calls that fail for other reasons (errors, timeouts) — that stays
  the calling agent's decision.

## User stories

> As a citizen developer, I want to define what my stock agent can do
> (e.g. check stock for a product code) so that any agent calling it knows
> exactly what to send and what to expect back.

> As a citizen developer, I want a calling agent to see a clear list of its
> connected agents' skills, so it fills in requests correctly without guessing.

> As a citizen developer, I want the platform to reject malformed requests and
> answers automatically, so I don't have to write defensive instructions in
> every workspace.

> As an agent, I want to declare and update my own skills by writing files in
> my workspace, so I can describe what I offer without human help.

> As an operator, I want every new workspace to include an example skill
> template, so declaring the first skill is a copy-and-edit task.

> As an operator, I want the work a called agent performs to appear in the
> usage dashboard under that agent's own workspace, so multi-agent costs are
> visible and attributable.

## Requirements

### Must have

- **Skills as workspace files** — each skill is one file in the workspace's
  `skills/` folder, stating its name, a description, the inputs it needs
  (required vs optional), and the answer format it promises. New workspaces are
  created with an example template to copy from.
- **Discovery** — the calling agent's list of connected agents shows each
  agent's skills with their inputs and answer format. A connected workspace
  with no skills is listed as not callable.
- **Structured calls** — a calling agent names the target workspace, the skill,
  and the filled-in inputs. Nothing else is sent.
- **Request checking** — requests with missing or wrong inputs are rejected
  with a precise explanation before the target agent runs. A caller that keeps
  sending invalid requests for the same skill is told to stop and reconsider
  after a small number of attempts.
- **Answer checking with correction** — the answering agent is told, per call,
  exactly what answer format is expected. If its answer doesn't match, it is
  shown precisely what was wrong and asked to correct itself, up to a small
  number of attempts; after that the call fails with a clear error instead of
  delivering a bad answer.
- **Clear failure reasons** — every failed call tells the caller why: not
  connected, unknown skill, invalid request, invalid answer, or the target
  agent failed while working.
- **Isolation** — every call runs in a fresh conversation for the answering
  agent. Human-to-agent chat is untouched and stays free-form.
- **Usage visibility** — token usage and tool activity of a called agent are
  recorded under its own workspace in the usage dashboard, with each call (and
  its correction attempts) grouped as one session.
- **Operator tuning** — the number of correction attempts allowed on each side
  is configurable.

### Nice to have

- **Examples per skill** — sample requests shown during discovery to further
  reduce guessing.
- **Strict mode** — per skill, reject requests or answers that contain fields
  beyond the agreed ones.
- **Batch inputs** — skills that accept a list in one request (e.g. several
  product codes at once) to reduce repeated calls in fan-out workflows.
- **Cancel a running call** — let the calling side abort a call that is taking
  too long.

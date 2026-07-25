# PRD — Workspace Internet Access Toggle

**Status:** Shipped
**Author:** @alxcls
**Related:** [VISION.md](../VISION.md), [prd-workspace-isolation.md](prd-workspace-isolation.md), [prd-workspace-third-party-api-keys.md](prd-workspace-third-party-api-keys.md)

---

## Problem

An agent with internet access can be steered by content it fetches — a scraped page, an API
response — into acting against the user's intent (prompt injection), and any secret configured for
the workspace travels over that same egress path. Some workspaces never need the internet at all
(pure data transforms, local scripts, offline analysis), and for those the safest posture is to
remove the network entirely rather than trust the agent or a content filter to behave.

There was previously no way to say "this workspace should never be able to reach the internet" —
every workspace got a route out by default.

---

## Goals

- A user can turn a workspace's internet access off, and the container gets **no network route
  out at all** — not a filtered one, not an agent instruction, an absent one.
- Off is safe to leave unattended: no combination of prompt injection or agent misbehavior can make
  it exfiltrate data or fetch external content, because there is nothing to connect to.
- The toggle is per-workspace and instant — flip it, the next run picks it up.
- New workspaces default to **off** (opt-in), so a freshly created workspace is never
  internet-exposed until the user decides it needs to be.

## Non-goals

- Domain-level allow/deny lists for an internet-*on* workspace — that's the existing per-secret
  domain scoping (see [prd-workspace-third-party-api-keys.md](prd-workspace-third-party-api-keys.md)), unchanged by this feature.
- Filtering or sanitizing content the agent fetches while on — out of scope; off is the answer for
  workspaces that can't tolerate that risk at all.
- Restricting drive access or cross-workspace agent calls — those are separate channels with their
  own controls, not "internet."

---

## User stories

> As a citizen developer running an unattended agent overnight, I want to turn internet off so I
> can walk away without worrying it gets hijacked by something it reads online.

> As a citizen developer building a workspace that only ever touches local files, I want internet
> off by default so I don't have to remember to lock it down myself.

> As a citizen developer who changes their mind mid-project, I want to flip access on for one
> workspace without affecting any other workspace.

---

## How it works today

A binary switch in the workspace's home panel (`InternetAccessBlock`). Off means:

- The container's Docker network is created `--internal` — no default route out, at the network
  layer, not an application check.
- The credential-proxy sidecar (the container's only possible egress path when on) is never
  attached to an off workspace's network.
- `http_get` and `apt_install` are not offered to the model as tools — it cannot call what isn't
  there.
- The system prompt tells the agent plainly that internet is off and shell attempts
  (`curl`/`npm install`/`git clone` against an external host) will fail, so it doesn't waste turns
  retrying.

Flipping the toggle stops the running container immediately; it comes back with the correct
network on next use — there is no window where the old setting lingers.

---

## Requirements

### Must have

- Off workspaces have zero network route to the internet, enforced below the application layer.
- The toggle takes effect on the container's next start, with no manual restart step for the user.
- New workspaces default to off.
- Existing workspaces created before this feature keep working (default to their prior, on,
  behavior) without any migration step from the user.
- The agent is told its current internet status in plain language, not left to infer it from tool
  failures.

### Nice to have

- Surface *why* a shell command failed (blocked by internet-access-off vs. a real network error) in
  the command output itself, not just the system prompt.
- A per-workspace activity indicator showing the last time internet access was toggled.

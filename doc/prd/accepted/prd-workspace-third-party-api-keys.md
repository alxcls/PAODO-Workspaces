# PRD — Third-Party Secrets

**Status:** Shipped
**Author:** @alxcls
**Related:** [VISION.md](../VISION.md)

---

## Problem

Agents often need a password or key to call an outside service (OpenAI, Stripe, an internal system…). Pasting that value directly into a workspace means the agent can read it, print it, or accidentally leak it into logs or conversation. Users need a way for their agent to *use* a credential without ever holding the real value.

This is a leak-resistance measure, not an unbreakable vault — see [Limitations](#limitations).

## Goals

- Let a user attach a secret to a workspace so the agent can call an outside service with it
- Keep the real value out of the workspace — the agent never sees or stores it
- Lock each secret to the one service it's meant for
- Let users add, view, and remove secrets from workspace settings

## Non-goals

- Sharing a secret across multiple workspaces
- Supporting credential types that can't be swapped in behind the scenes (rare, advanced signing schemes)
- Automatic rotation or expiry — secrets are managed manually

## User stories

> As a user, I want my agent to call an external API without me putting my real credential somewhere it can read it.

> As a user, I want a careless agent to be unable to leak my secret by accident.

> As a user, I want each secret restricted to the one service it belongs to.

> As a user, I want to add and remove a workspace's secrets from its settings page.

## What the user gets

- Add a secret with a name, a value, and which external service it's for
- The real value is never shown again after saving, and never visible to the agent — only its name and target service are
- The secret only ever gets used for calls to the service it was set up for, never anywhere else
- Secrets can be listed and deleted anytime from workspace settings
- Deleting a workspace deletes all of its secrets

## Limitations

This feature reduces the chance of *accidental* leaks. It does not stop every possible misuse.

**What it protects against:** the agent printing, logging, or echoing the real value by accident. It never holds the plaintext value at all.

**What it doesn't protect against:**
- A determined or manipulated agent that deliberately tries to trick the target service into revealing the secret back to it
- Someone who gains access to the underlying server itself — secrets are stored there, not in a separate vault
- A handful of advanced/rare authentication styles that can't be substituted in behind the scenes and must be handled another way
- A few uncommon connection types to a set-up service, which currently just fail rather than risk a leak

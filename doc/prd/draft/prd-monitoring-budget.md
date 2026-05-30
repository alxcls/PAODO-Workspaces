# PRD — Budget

**Status:** Draft  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md), [monitoring.md](monitoring.md)

---

## Problem

A runaway agent or a misconfigured workspace can silently consume a large number of tokens before the user notices. There is currently no way to set a ceiling on how much a workspace is allowed to spend.

## Goals

- Users can set a token budget per workspace
- The agent stops gracefully when the budget is reached

## Non-goals

- Dollar-denominated budgets (token-based only for now)
- Global platform-wide limits
- Automatic budget renewal or rollover

## User stories

> As a self-hoster, I want to cap how many tokens a workspace can use so that a looping agent cannot drain my API quota overnight.

## Requirements

### Must have

- A user can set an optional token budget (total tokens) on any workspace
- When a run would exceed the budget, it is stopped before the next loop iteration and the user receives a clear message explaining why
- A workspace with no budget set behaves exactly as today — no change

### Nice to have

- A warning notification when usage reaches a configurable percentage of the budget (e.g. 80%)
- Budget resets on a schedule (daily, weekly, monthly)

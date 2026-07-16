# PRD — Agent Network

**Status:** Shipped  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md)

---

## Problem

A citizen developer building a complex service needs to coordinate multiple specialized workspace agents — for example, one that fetches data, one that processes it, and one that reports results. without it either everything is crammed into one workspace (hard to maintain, hard to reason about) or the user manually copies outputs between workspaces themselves. It allows modularity and service distribution. we can separate concerns so each agent has it's own ressources and goal.

## Goals

- A user can define which workspace agents are allowed to talk to each other
- An agent can delegate a task to another agent and get a response back, without user intervention
- The user stays in control of the collaboration topology at all times

## Non-goals

- Agents sharing memory or conversation history across calls
- Agents modifying the network topology themselves
- Real-time or parallel agent communication
- Automated orchestration — the user always defines the graph manually

## User stories

> As a citizen developer, I want to connect a "coordinator" workspace to a "data-fetcher" workspace so that my coordinator agent can delegate data retrieval without me having to switch workspaces manually.

> As a citizen developer, I want to ensure that my "data-fetcher" agent cannot call my "coordinator" back, so I stay in control of who initiates what.

> As a citizen developer, I want to visually see which agents are connected so I can reason about my service architecture at a glance.

## Requirements

### Must have

- User can create a directed connection between two workspaces (A can call B, but not the reverse to avoid loops) it also works on multiple level no loop is allowed
- The network must be acyclic — no circular dependencies between agents
- An agent can call a connected agent by name and pass it a task in plain text
- The caller agent receives the callee's response and can act on it
- If a call fails (agent not found, not connected, timed out, or errored), the caller receives a clear error message and decides how to handle it — no automatic retry
- An agent can discover which other agents it is allowed to call

### Nice to have

- Visual graph editor where the user can see and edit connections between workspaces

## Note

This feature is gated behind `GRAPH_ENABLED=true`

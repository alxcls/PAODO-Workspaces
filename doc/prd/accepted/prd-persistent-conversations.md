# PRD — Persistent Conversations

**Status:** Shipped  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md)

---

## Problem

A workspace used to have a single chat that vanished on refresh. Users couldn't keep more than one line of work going, couldn't come back to an earlier exchange, and lost their history whenever they reloaded the page. This makes the workspace feel disposable and discourages longer or parallel tasks.

---

## Goals

- Conversations are saved and survive a page refresh or returning later.
- A user can run several separate conversations in the same workspace and switch between them.
- A user can see their list of past conversations and reopen any of them.
- A running agent can be stopped without losing the conversation.

---

## Non-goals

- Sharing conversations between different users.
- Searching across conversation history.
- Editing or branching past messages.

---

## User stories

**Story 1 — User comes back to earlier work**  
As a citizen developer, when I reopen a workspace, my previous conversation and its messages are still there.

**Story 2 — User runs parallel tasks**  
As a citizen developer, I can start a new conversation alongside an existing one and switch between them using the conversation bar.

**Story 3 — User stops a run**  
As a citizen developer, when an agent is taking too long or going the wrong way, I can stop it and the conversation stays intact.

---

## Requirements

### Must have

- Conversations and their messages are stored and reload automatically.
- A conversation bar lets the user view, switch, and create conversations.
- The user can stop an in-progress run.
- A new run resumes the correct conversation's history.

### Nice to have

- Renaming conversations.
- Deleting old conversations from the UI.

---

# PRD — Agent Capabilities

**Status:** Shipped  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md), [prd-lock-mechanism.md](prd-lock-mechanism.md), [prd-agent-network.md](prd-agent-network.md)

---

## Problem

An agent with no ability to act is just a text oracle — it can reason and plan but cannot change anything. For PAODO WS to deliver on its core promise (describe what you want, it writes the code, runs it, and logs what happened), the agent must be able to work with files, run programs, look things up on the web, and keep track of its own progress across multi-step tasks.

Without these capabilities the agent either reasons from stale or incomplete information, produces answers the user must act on manually, and loses its place the moment a task gets interrupted.

## Goals

- The agent can read, write, and edit any unlocked file in the workspace without leaving the conversation
- The agent can run commands and the user sees live output in the browser as they execute
- The agent can explore the workspace to orient itself in an unfamiliar project
- The agent can look up documentation and APIs on the web
- The agent can maintain a visible task checklist so multi-step plans are transparent to the user in real time
- The agent can compact its own conversation context mid-task so long, multi-step jobs don't exhaust the model's context window
- File locking is respected — the agent cannot modify files the user has locked

## Non-goals

- Agent-to-agent communication — covered separately in [prd-agent-network.md](prd-agent-network.md)
- File lock management — the lock mechanism and its UI is covered in [prd-lock-mechanism.md](prd-lock-mechanism.md)
- Web search (finding relevant URLs by querying a search engine) — the agent can only fetch a URL it already knows
- Binary files — all file operations work on text only
- Browser automation — the agent fetches raw page content, it does not drive a browser or interact with JavaScript-rendered pages

## User stories

> As a citizen developer, I want the agent to read my existing config files before editing them so it never overwrites something it hasn't seen.

> As a citizen developer, I want the agent to run npm install, run tests, and start my server for me so I don't have to copy-paste commands from the chat.

> As a citizen developer, I want to watch commands run live in the browser so I know the agent isn't stuck.

> As a citizen developer, I want the agent to explore my workspace so it can orient itself in an unfamiliar project without asking me where everything is.

> As a citizen developer, I want the agent to fetch a library's documentation page so it can use the right API without hallucinating method signatures.

> As a citizen developer, I want a visible task list that updates as the agent works through a multi-step plan so I can follow along and spot if it goes off track.

> As a citizen developer, I want the agent to trim its own context on a long, repetitive job so it can finish all the work instead of stalling out when the conversation gets too big for the model.

## Requirements

### Must have

**Reading the workspace**

- The agent can read any file, with support for reading large files in sections
- The agent can list the contents of a directory
- The agent can search for files by name pattern across the whole workspace
- Every read result indicates whether the file is locked or editable

**Writing to the workspace**

- The agent can create a new file or fully overwrite an existing one
- The agent can make a targeted edit — replacing an exact passage in a file — without touching the rest
- Write operations are blocked on locked files and cannot escape the workspace directory
- The agent must read a file before editing it

**Running commands**

- The agent can run any shell command inside the workspace
- Output streams live to the browser console as it runs, not buffered until exit
- A heartbeat appears in the console every 5 seconds during silence so the user knows long-running commands are alive
- Commands time out after 120 seconds
- Privilege escalation commands are unconditionally blocked
- When the workspace is globally locked, commands run as a restricted user with no write access

**Web access**

- The agent can fetch the content of any public URL as plain text
- HTML pages are stripped of scripts, styles, and markup — only readable text is returned
- Output is capped at 20 000 characters with a notice if truncated

**Task tracking**

- The agent can maintain a checklist of pending, in-progress, and completed tasks
- The checklist is visible to the user in the UI alongside the console

**Context management**

- The agent can compact its own conversation history mid-run, choosing how aggressively (light / medium / hard)
- Every compaction carries forward a next-step note so the agent does not lose the thread after trimming
- Compaction never orphans history: the turn that requested it is committed first, so a later resume always sees a valid conversation

### Nice to have

- A dedicated rename/move operation (today the agent shells out to do this)
- A cap on command output so a runaway process cannot flood the agent's context
- Task list persisted to disk so it survives server restarts
- Automatic pretty-printing when a fetched URL returns JSON

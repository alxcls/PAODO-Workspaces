# PRD — Faster Agent Response Display

**Status:** Draft  
**Author:** alxcls

---

## Problem

After the agent finishes using tools, there is a noticeable pause before any text appears in the chat. The agent has already done its work — it just isn't showing the answer yet.

## Goals

Make the agent's final response start appearing immediately after the last tool finishes, with no unnecessary delay.

## Non-goals

- Reducing the time it takes the AI model itself to think and respond — that is controlled by the API provider (Anthropic / OpenAI) and outside our control.
- Changing how tools work or how fast they run.

## User stories

- As a user, when the agent finishes a task I want to see its response start appearing right away, not after a blank pause.

## Requirements

### Must have

- The agent's response text starts streaming to the screen as soon as the model begins generating it, not after it has finished.

### Nice to have

- A visual indicator (spinner or "thinking…" label) during the unavoidable gap between the last tool result and the first word of the response, so the interface never looks frozen.

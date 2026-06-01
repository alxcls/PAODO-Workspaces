# Agent Loop

The agent loop lives in `lib/agent/runner.ts` (`runAgent`). It drives the model until it produces a response with no tool calls.

## Flow

```
messages = [SystemPrompt, ...history]
messages.push(HumanMessage)
         │
         ▼
┌─────────────────────────────────────────────┐
│  stream(messages)                           │
│  • yield token events as text arrives       │
│  • accumulate tool_call_chunks by index     │
└──────────────────┬──────────────────────────┘
                   │
        ┌──────────┴──────────┐
   tool calls?               no
        │                    │
        ▼                    ▼
  push AIMessage        check inline JSON
  (content + tool_calls)      │
        │              ┌──────┴──────┐
  run tools         found?          no
  in parallel          │             │
        │          treat as      push AIMessage
  push ToolMessage  tool call     yield "done"
  for each result   continue      break ◄───── end
        │
        └──────────────────────────────────────┐
                  loop back to stream()        │
                  (model sees tool results     │
                   and decides what to do next)│
                                               │
         ← repeat until model produces ────────┘
           a turn with no tool calls
```

## Key points

- **`messages` is a shared mutable array.** Every turn appends to it (`HumanMessage` → `AIMessage` → `ToolMessage` → `AIMessage` → ...). This is the model's working memory for the whole interaction.
- **The model decides when it's done.** It signals this by producing a response with no tool calls. Each workspace has a configurable `maxIterations` cap (default 30); when hit, the agent emits a final summary response tagged `iterationLimitReached: true` rather than crashing.
- **Tools run in parallel within a turn** (`Promise.all`). If the model calls `file_read` and `glob` at the same time, both execute concurrently and their results are pushed back together.
- **`call_agent` is just another tool** from the loop's perspective. It internally runs a complete nested `runAgent` loop on another workspace before returning its result string. The outer loop does not know or care.
- **The `signal` (HTTP request abort) threads through every `stream()` call**, so if the browser disconnects mid-loop the whole thing stops cleanly.
- **Inline JSON tool calls** are a legacy fallback for models that emit raw `{"name":…,"parameters":…}` text instead of using native tool_calls. Handled as a best-effort after the stream ends.

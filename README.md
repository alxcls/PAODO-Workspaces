# PAODO — Self-Hosted AI Workspace Agents

A self-hosted platform where each **workspace** is a sandboxed directory with its own AI agent. Agents can read and write files, run shell commands, fetch URLs, manage task lists, and call each other over a configurable agent network — all from a browser UI or HTTP API.

## What it does

- **Workspaces** — isolated directories on disk, each with its own agent, conversation history, and `AGENTS.md` instruction file
- **ReAct agent loop** — streams tool calls and responses in real time over SSE; final tokens stream word by word
- **Full tool set** — file read/edit/write, shell execution, glob search, directory listing, web fetch, task list
- **File locks** — per-file and per-directory R/RW toggle protects workspace files from accidental agent edits without blocking scripts
- **Agent-to-agent calls** — connect workspaces in a directed graph; agents delegate tasks to each other
- **File browser** — view, edit, upload, and download files from the UI with syntax highlighting
- **API access** — every workspace exposes an HTTP endpoint with an optional per-workspace API key
- **Live console** — shell output and file-change notifications stream over WebSocket in real time

## Quick start

**Requirements:** Node.js 20+, an OpenAI API key

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY

# 3. Run in development mode
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

For production:
```bash
npm run build   # build Next.js
npm start       # run the custom server
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | Your OpenAI secret key |
| `OPENAI_MODEL` | No | `gpt-5.1-codex-mini` | Model to use for all agents |
| `PORT` | No | `3000` | HTTP port |
| `NODE_ENV` | No | `development` | Set to `production` to disable Next.js HMR |
| `DEBUG` | No | — | Set to `1` to enable verbose tool call logging |

## How it works

```
Browser / API client
       │
  Next.js API routes (app/api/)
       │
  Agent runner (lib/agent/runner.ts)   ←── AsyncGenerator streaming AgentEvents
       │
  Tool set (lib/agent/tools/)          ←── file ops, shell, web, agent calls
       │
  Workspace dir (data/<workspace>/)
```

The custom entry point (`server.ts`) mounts Next.js on a plain Node.js HTTP server so that a WebSocket server can share the same port. WS connections at `/ws?workspaceId=<id>` receive real-time shell output and file-change notifications.

Persistence is intentionally lightweight:
- Workspace metadata (name, directory path) → `data/.workspaces.json`
- API keys (hashed) → `data/.api-keys.json`
- Agent network graph → `data/workspace-graph.json`
- **Conversation history** is in-memory only and resets when the server restarts or the browser tab closes

## Workspaces

Each workspace is a directory under `./data/`. Two files are created automatically:

- **`AGENTS.md`** — injected as the system prompt for every request. Edit it to give the agent custom instructions, domain knowledge, or persona.
- **`state.md`** — intended as a running log. Scripts in the workspace can append to it; the agent reads it for context.

## File locks

Every file and directory in a workspace can be marked **[R]** (read-only) or **[RW]** (read-write) from the file tree panel. Click the lock icon next to any file or directory to toggle it; the master lock button at the top locks or unlocks the entire workspace at once.

**How it works:**
- Lock state is stored outside the workspace (under `data/.agent-permissions/<workspaceId>.json`), so the agent never sees or edits it.
- The agent's `file_edit` and `file_write` tools check this metadata and refuse to write to locked paths.
- Shell commands run via `execute_command` are **not** affected — scripts like `python3 make_pizza.py` can write to any file regardless of lock state. Locks are a guardrail against accidental agent edits, not a security boundary.
- `AGENTS.md` is always locked (`chmod 0o444`) and cannot be unlocked — it is the one file the agent must never self-modify.

Lock state is preserved across server restarts. Existing workspaces with old filesystem-based locks are automatically migrated on first access.

## Agent network

The `/graph` page lets you draw directed edges between workspaces. An edge from workspace A to workspace B means A's agent can call B's agent using the `call_agent` tool. Calls are isolated — the callee runs with a fresh conversation history. Cycles are prevented in the UI.

## API access

Each workspace can be called over HTTP. Enable API access from the workspace panel to generate a key.

```bash
curl -X POST http://localhost:3000/api/workspaces/<id>/agent \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"message": "list all files and summarize what this workspace does"}'
```

The response streams `AgentEvent` objects as newline-delimited JSON:
```
{"type":"tool_start","name":"list_directory"}
{"type":"tool_result","name":"list_directory","result":"..."}
{"type":"token","content":"This workspace contains..."}
{"type":"done"}
```

## Project structure

```
server.ts                   Custom Node.js entry point (Next.js + WebSocket on one port)
app/
  api/                      Next.js API routes
  workspace/[id]/           Workspace UI page
  graph/                    Agent network graph UI
lib/
  agent/
    runner.ts               ReAct agent loop (AsyncGenerator)
    systemPrompt.ts         System prompt builder
    tools/                  One file per tool
  infra/
    workspaceStore.ts       Workspace CRUD + in-memory message history
    permissionStore.ts      Per-workspace file lock metadata (R/RW)
    apiKeyStore.ts          Per-workspace API key management
    wsHub.ts                WebSocket connection registry
    workspaceWatcher.ts     File-change watcher (chokidar → WS broadcast)
    rateLimit.ts            In-memory IP rate limiter
    todoStore.ts            In-memory agent task list
components/                 React UI components
data/                       Runtime data (workspaces, keys, graph) — gitignored
dev_tools/                  Codebase graph builder and query tool
```

## Known limitations

- **Single instance only** — the rate limiter, WebSocket registry, and workspace registry use in-memory state. Running multiple server processes without a shared store will cause inconsistent behavior.
- **Conversation history not persisted** — resets on server restart. The workspace files and `state.md` are the intended long-term memory.
- **No database** — all workspace state lives in JSON files; suitable for prototyping but not production-grade durability or concurrency.
- **Concurrent agent sessions work** — multiple agents can target the same workspace simultaneously with isolated memory and a shared console stream; however there is no file locking or queue, so simultaneous writes to the same file are unprotected and could silently overwrite each other under high load.
- **No environment isolation** — all workspaces share the host's languages, libraries, and dependencies; conflicting runtime requirements between workspaces are not supported.
- **No context compaction** — conversation history grows unbounded per session; there is no manual compact or auto-compact to summarize and trim old messages, so long sessions will eventually hit the model's context limit.
- **History is scoped by use case** — the browser chat maintains full stateful history across turns; external API calls (`/api/workspaces/[id]/agent`) and agent-to-agent calls (`call_agent`) are stateless and start fresh on every request, meaning multi-turn conversations over the API require the caller to manage context themselves or a session layer to be added. to integrate with compaction.

## Dev tools

```bash
npm run query-graph -- summary          # codebase overview
npm run query-graph -- file <relpath>   # imports/exports for one file
npm run graph                           # open visual dependency graph in browser
```

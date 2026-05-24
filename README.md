# PAODO — Self-Hosted AI Workspace Agents

A self-hosted platform for running small, grounded AI-managed services. Each **workspace** is an isolated Docker container with its own agent: write a service, drop in instructions, let the agent operate it. Agents can read and write files, run shell commands, fetch URLs, manage task lists, and call each other over a configurable agent network.

## What it does

- **Workspaces** — isolated Docker containers with a bind-mounted directory, each with its own agent and `AGENTS.md` instruction file
- **ReAct agent loop** — streams tool calls and responses in real time over SSE; final tokens stream word by word
- **Full tool set** — file read/edit/write, shell execution, glob search, directory listing, web fetch, todo list
- **File locks** — per-file and per-directory R/RW toggle protects workspace files from accidental agent edits without blocking scripts
- **Agent-to-agent calls** — connect workspaces in a directed graph; agents delegate tasks to each other
- **File browser** — view, edit, upload, and download files from the UI with syntax highlighting
- **API access** — every workspace exposes an HTTP endpoint with an optional per-workspace API key
- **Live console** — shell output and file-change notifications stream over WebSocket in real time

## Quick start

**Requirements:** Node.js 20+, Docker, an OpenAI API key

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

## How it works

**Entry point** — `server.ts` boots a plain Node.js HTTP server that mounts Next.js alongside a WebSocket server on the same port. This lets shell output and file-change notifications stream over `/ws` in real time without a separate process.

**Request flow**

```
Browser / API client
       │  HTTP (REST + SSE)              WebSocket (/ws?workspaceId=<id>)
       ▼                                       ▲
Next.js API routes (app/api/)                  │
       │                                wsHub broadcasts
       ▼                                shell output + file events
Agent runner (lib/agent/runner.ts)
  AsyncGenerator → AgentEvent stream
       │
  ReAct loop: think → pick tool → observe → repeat
       │
  ┌────────────────┬─────────────────────────────┐
  │  File tools    │  execute_command            │
  │  (read/edit/   │  → Docker container         │
  │   write/glob)  │    ws_<workspaceId>         │
  │       │        │    (lazy spawn, auto-idle)  │
  └───────┼────────┴──────────────┬──────────────┘
          │                       │
          └───────────┬───────────┘
                      ▼
             data/<workspace>/
             (bind-mounted dir)
```

**Agent loop** — each turn the model receives the conversation history plus tool results and emits either a tool call or a final answer. Tool calls are executed, their output appended to history, and the loop continues until the model stops calling tools. Events (`tool_start`, `tool_result`, `token`, `done`) are streamed over SSE so the UI updates word by word.

**Sandboxing** — `execute_command` runs inside a per-workspace Docker container (`ws_<id>`) with the workspace directory bind-mounted to `/workspace`. Containers are created lazily, restarted automatically, and stopped after idle timeout. A global lock switches execution to a restricted user (`agent`, UID 999) that can read and run but not write — useful for safe demos or shared workspaces.

**Persistence** is intentionally lightweight: workspace metadata and the agent network graph live in JSON files under `data/` (written atomically — crash-safe); conversation history is in-memory only and resets on restart or tab close.

## Workspaces

Each workspace is a directory under `./data/`. One file is created automatically:

- **`AGENTS.md`** — injected as the system prompt for every request. Edit it to give the agent custom instructions, domain knowledge, or persona.

## File locks

Every file and directory in a workspace can be marked **[R]** (read-only) or **[RW]** (read-write) from the file tree panel. Click the lock icon next to any file or directory to toggle it; the master lock button at the top locks or unlocks the entire workspace at once.

**How it works:**
- Lock state is stored outside the workspace (under `data/.agent-permissions/<workspaceId>.json`), so the agent never sees or edits it.
- The agent's `file_edit` and `file_write` tools check this metadata and refuse to write to locked paths.
- Shell commands run via `execute_command` are **not** affected by per-file locks — a script the agent creates and runs can overwrite any locked file at the OS level. See [doc/file-lock-shell-bypass.md](doc/file-lock-shell-bypass.md) for the full analysis and the designed fix. The global lock (master lock button) is the only currently airtight enforcement.
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
server.ts                         Custom Node.js entry point (Next.js + WebSocket on one port)
Dockerfile                        Production image for the platform
Dockerfile.workspace              Sandbox image used per workspace container
docker-compose.yml                Compose file for local multi-container setup
doc/                              Architecture and security documentation
app/
  api/
    workspaces/[id]/
      agent/                      SSE streaming agent endpoint
      chat/                       Browser chat endpoint (stateful history)
      files/                      File CRUD + upload + download
      serve/[...filepath]/        Static file server (HTML previews, assets)
      permissions/                Per-workspace file permission management
      api-key/                    API key management
    workspace-graph/              Workspace relationship graph API
  workspace/[id]/                 Workspace UI page
  graph/                          Agent network graph UI
lib/
  agent/
    runner.ts                     ReAct agent loop (AsyncGenerator → AgentEvent)
    systemPrompt.ts               System prompt builder (injects AGENTS.md)
    tools/                        One file per agent tool (read, write, edit, exec, glob, fetch…)
  infra/
    workspaceStore.ts             Workspace CRUD + in-memory message history
    permissionStore.ts            Per-workspace file lock metadata (R/RW)
    apiKeyStore.ts                Per-workspace API key management
    wsHub.ts                      WebSocket connection registry
    workspaceWatcher.ts           File-change watcher (chokidar → WS broadcast)
    workspaceGraph.ts             Workspace relationship graph (agent-to-agent topology)
    containerManager.ts           Docker container lifecycle per workspace
    rateLimit.ts                  In-memory IP rate limiter
    todoStore.ts                  In-memory agent task list
  highlighter.ts                  Shared highlight.js instance with registered languages
components/
  workspace/
    ChatPanel.tsx                 Chat UI + SSE agent event renderer
    FileTreePanel.tsx             File tree browser with upload support
    FileViewer.tsx                File viewer/editor (syntax, MD, HTML, JSON previews)
    ConsolePanel.tsx              Live shell output panel (WebSocket)
  graph/
    GraphEditor.tsx               Interactive workspace graph visualization
  home/                           Home page blocks (description, API access)
  layout/
    TopBar.tsx                    Global top navigation bar
data/                             Runtime data (workspaces, keys, graph) — gitignored
dev_tools/                        Codebase graph builder and query tool
```

## Agent limitations

- **A stuck command freezes the agent.** If a shell command never finishes (infinite loop, waiting for input, hung process), the agent waits forever for that turn. There is no timeout — only closing the browser tab or restarting the server will unblock it.

- **The agent can loop forever if confused.** There is no cap on how many tool calls the agent can make in a single response. A confused agent can keep calling tools indefinitely, burning tokens and blocking the workspace until you intervene.

- **Task lists are lost on restart.** The agent's todo list (`todo_write`) lives in memory only. If the server restarts mid-task, the agent has no memory of what it was doing — it starts completely fresh.

## Known limitations

- **Single instance only** — the rate limiter, WebSocket registry, and workspace registry use in-memory state. Running multiple server processes without a shared store will cause inconsistent behavior.

- **Conversation history not persisted** — resets on server restart. Workspace files (scripts, data, `AGENTS.md`) are the intended long-term memory.

- **Concurrent agent sessions work** — multiple agents can target the same workspace simultaneously with isolated memory and a shared console stream; however there is no file locking or queue, so simultaneous writes to the same file are unprotected and could silently overwrite each other under high load.

- **No context compaction** — conversation history grows unbounded per session; there is no manual compact or auto-compact to summarize and trim old messages, so long sessions will eventually hit the model's context limit.

- **No image reading** — the agent has no tool to read or interpret image files; it can manipulate them as raw files but cannot see their content.

- **Conversation history differs by entry point** — three distinct behaviors:
  
  - **Browser chat** (`/chat`): stateful, history accumulates across turns for the duration of the tab session, resets on refresh or server restart

  - **External API** (`/agent`): stateless, every request starts with a fresh context — multi-turn conversations require the caller to pass history themselves
  
  - **Agent-to-agent calls** (`call_agent`): stateless, each call starts fresh regardless of the caller's own history

- **Per-file locks do not prevent shell-level writes** — locking a file blocks the agent's `file_edit` and `file_write` tools, but the agent can write a script to an unlocked path and run it via `execute_command`, bypassing lock checks entirely. The global lock is the only currently airtight enforcement. See [doc/file-lock-shell-bypass.md](doc/file-lock-shell-bypass.md).

- **Single LLM provider** — only OpenAI is supported; there is no way to switch to another provider such as Anthropic or Mistral.

- **Single model for all agents** — the model is set globally via the `OPENAI_model` env var; individual workspaces cannot use a different model.

## Dev tools

```bash
npm run query-graph -- summary          # codebase overview
npm run query-graph -- file <relpath>   # imports/exports for one file
npm run graph                           # open visual dependency graph in browser
```

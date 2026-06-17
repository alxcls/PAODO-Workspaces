# PAODO Workspace — Self-Hosted AI Agents You Run on Your Own Infra

A self-hosted platform for running small, grounded AI services on infrastructure you control — your VPS, your model, your data. Each **workspace** is an isolated Docker container with its own agent: write a service, drop in instructions, and call it over an API. Workspaces can also be wired into a directed graph, letting agents discover their neighbors and **delegate tasks to each other**. Think VS Code and Claude Code in a sandboxed workspace, callable as a service.

![Workspace overview](doc/images/DEMO_OVERVIEW.png)

## What it does

- **Workspaces**: isolated Docker containers, each with its own agent and `AGENTS.md` instruction file, all files and shell operations run inside the container
- **ReAct agent loop**: streams tool calls in real time over SSE; final response delivered as a single event once the loop completes
- **Full tool set**: file read/edit/write, shell execution, glob search, directory listing, web fetch, todo list
- **File browser**: view, edit, upload, and download files from the UI with syntax highlighting and preview for .html, .md and .json
- **API access**: every workspace exposes an HTTP endpoint with a per-workspace API key to trigger the workspace agent exernally
- **Live console**: shell output and file-change notifications stream over WebSocket in real time
- **Agent-to-agent calls** : connect workspaces in a directed graph; workspace agents can discover other workspace agents and delegate tasks enabling complex multi CLI agents workflows


## Quick start

**Requirements:** Node.js 20+, [Docker](https://docs.docker.com/get-docker/) (installed and running), an OpenAI API key or an Anthropic API key

```bash
# 1. Clone
git clone https://github.com/alxcls/PAODO_WS.git
cd PAODO_WS

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env

# 4. Start
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or whichever `PORT` you set). The Docker image used to run workspaces is built automatically on first run.

For self-hosting on a VPS, see the [deploy guide](deploy/README.md).

## How it works

**Entry point**: `server.ts` boots a plain Node.js HTTP server that mounts Next.js alongside a WebSocket server on the same port. This lets shell output and file-change notifications stream over `/ws` in real time without a separate process.

**Request flow**

```
Browser / API client
  ├── Chat UI (stateful) ──┐
  └── External API ─────── ┘  HTTP (REST + SSE)
       (stateless)
            │
            │                         WebSocket (/ws?workspaceId=<id>)
            ▼                                    ▲
  Next.js API routes (app/api/)            wsHub broadcasts
            │                          shell output + file events
            ▼
     agentStream.ts
    (SSE → Response)
            │
            ▼
  lib/agent/runner.ts
    AsyncGenerator → AgentEvent
            │
  ReAct loop: think → pick tool → observe → repeat
            │
            ▼
  Docker container ws_<workspaceId>
  (spawned at session start, auto-idle)
  ┌──────────────────────────────────┐
  │  Sandboxed tools via docker exec │
  │  ├── file_read / file_write      │
  │  ├── file_edit / glob            │
  │  ├── list_directory              │
  │  ├── execute_command             │
  │  └── apt_install                 │
  │        /workspace/               │
  │   (volume-subpath mounted)       │
  └──────────────────────────────────┘

  Tools that run outside the container
  ├── todo_write   (in-memory todo list)
  ├── http_get     (fetch a URL)
  └── call_agent / list_agents (agent network, graph-gated)
```

**Agent loop**: each turn the model receives a system prompt (built from the standard system prompt and workspace's `AGENTS.md`), the conversation history, and tool results, then emits either a tool call or a final answer. Tool calls are executed, their output appended to history, and the loop continues until the model stops calling tools. Events (`tool_start`, `tool_result`, `token`, `done`) are streamed over SSE so the UI updates word by word.

**Sandboxing**: all sandboxed tool calls — file reads, writes, edits, directory listings, glob searches, package installs, and shell commands — are executed inside a per-workspace Docker container (`ws_<id>`). The container is started when a session begins, stopped after an idle timeout, and restarted automatically on the next tool call. Only that workspace's directory is mounted into the container (`/workspace`), enforcing isolation at the container level. Shell commands run as a restricted non-root user (`agent`, UID 999) with dropped capabilities, limiting what the agent can do even within the container.

**Persistence** is intentionally lightweight: workspace metadata and the agent network graph live in JSON files under `data/`; conversation history is in-memory only and resets on restart or tab close.

## Workspaces

A workspace is a self-contained project environment stored under `/data/<workspace-name>`. It contains the project files the agent can read and edit, workspace-specific metadata (`AGENTS.md`, settings, conversation history), API keys, and runtime state.

Workspaces are isolated from one another: file edits and shell commands are confined to that workspace directory. A common workflow is to create one workspace per service, then add project-specific and dedicated scripts and dataset.

![Data visualization](doc/images/DATA_VIZ.png)

## Agent network

Workspaces aren't only callable by you over HTTP — they can call each other. The network page connects workspaces into a directed graph; an edge from **A → B** authorizes A's agent to invoke B's. Agents discover their reachable neighbors with `list_agents` and call them with `call_agent`.

Calls are **contract-first**, not free-form chat. Each workspace publishes one or more **skills** — named actions with JSON-Schema-typed inputs and outputs, one `skills/*.json` file per skill (authored in the UI or written by the agent itself via `file_write`; an `example-skill.json.template` is seeded at creation). A workspace with no declared skills is not callable.

A skill author is free to define any input and output schema; the platform then holds the **caller** to the input schema and the **callee** to the output schema, enforcing both sides of every skill contract:

1. **Authorization** — rejected unless a graph edge connects caller → callee.
2. **Input validation** — `args` are validated against the skill's `parameters` schema before the callee runs.
3. **Isolated execution** — the callee runs in a fresh conversation with no memory of the caller's context.
4. **Output validation** — the callee's response is validated against the skill's `output` schema; on mismatch the error is fed back and the callee re-runs, bounded by a retry cap.

Both agents run in the same Node.js process, so a call is an ordinary in-process function call — no HTTP, no serialization between agents. A callee that can't resolve schema-valid args (a typo'd id, an ambiguous value) can reply `{"_needs_input": "<question>"}` instead of guessing; the caller is then prompted to re-call with corrected args, bounded to a few rounds. The graph is a DAG, so cycles are prevented.

> **Note:** The agent network is on by default. To disable agent-to-agent calls entirely, set `GRAPH_ENABLED=false` in your `.env`.

![Agent Network](doc/images/NETWORK_EXAMPLE.png)

## API access

Each workspace can be called over HTTP. Enable API access from the workspace panel to generate a key.

```bash
curl -X POST http://localhost:<port>/api/workspaces/<id>/agent \
  -H "Authorization: Bearer <api-key>" \
  -d '{"message": "list all files and summarize what this workspace does"}'
```

The response is a Server-Sent Events stream:
```
data: {"type":"tool_start","name":"list_directory"}

data: {"type":"response","content":"This workspace contains...","iterationLimitReached":false}

data: {"type":"done"}
```

## Project structure

```
server.ts                    Custom entry: mounts Next.js + WebSocket server on one port
Dockerfile                   Platform image
Dockerfile.workspace         Per-workspace sandbox image (built automatically on first run)
app/api/workspaces/[id]/     REST + SSE endpoints: agent, chat, files, permissions, api-key
app/api/workspace-graph/     Agent network topology API
lib/agent/
  runner.ts                  ReAct loop: AsyncGenerator that streams AgentEvent objects
  systemPrompt.ts            Injects workspace AGENTS.md into every prompt
  tools/                     One file per tool (read, write, edit, exec, glob, fetch, call_agent…)
lib/infra/                   Persistence + runtime services (workspace store, container manager, WS hub…)
components/                  UI panels: chat, file tree, file viewer, live console, graph editor
data/                        Runtime state: gitignored (workspaces, keys, graph)
dev_tools/                   Codebase graph builder (npm run query-graph)
doc/                         Architecture docs, PRDs, ADRs
```

## Known limitations

- **No context compaction**: conversation history grows unbounded per session; there is no manual compact or auto-compact to summarize and trim old messages, so long sessions will eventually hit the model's context limit.

- **Conversation history not persisted**: resets on server restart. Task lists (`todo_write`) are also in-memory only. Workspace files (scripts, data, `AGENTS.md`) are the intended long-term memory.

- **Conversation history differs by entry point**:

  - **Browser chat** (`/chat`): stateful, history accumulates across turns for the duration of the tab session, resets on refresh or server restart
  - **External API** (`/agent`): stateless, every request starts with a fresh context: multi-turn conversations require the caller to pass history themselves
  - **Agent-to-agent calls** (`call_agent`): stateless, each call starts fresh regardless of the caller's own history

- **Concurrent agent sessions work**: multiple agents can target the same workspace simultaneously with isolated memory and a shared console stream; however there is no file queue, so simultaneous writes to the same file are unprotected and could silently overwrite each other under high load.

- **No image reading**: the agent has no tool to read or interpret image files; it can manipulate them as raw files but cannot see their content.

## Roadmap

- Shared file drive mountable across workspaces
- Context compaction
- Budget monitoring
- Scheduled agent triggers
- Workspace git versioning
- Database storage
- Agent database tools

## ADRs & PRDs

- PRD (Product Requirement Document): describes what to build and why. Keep PRDs in `doc/prd/` (use `doc/prd/draft/`, `doc/prd/accepted/`, `doc/prd/archived/`).
- ADR (Architecture Decision Record): records a significant technical decision and its trade-offs. Keep ADRs in `doc/adr/`.
- Use PRDs for product/spec discussions and ADRs to capture the final architecture choices so the team remembers why we did things.

## Dev tools

This is two small dev tools for agent and devs to understand dependencies and radius blast while developing one is visual and the other is textual.

```bash
npm run query-graph -- summary          # codebase overview
npm run query-graph -- file <relpath>   # imports/exports for one file
npm run graph                           # open visual dependency graph in browser
```

## Get in touch

I'm not a professional developer, this is a personal project I built to learn and experiment and have a power tool on shelf to develop small CLI agent services in an agentic workflow. If you have questions, spot a security issue, want to suggest an improvement, or just feel like sharing feedback, feel free to reach out. Any advice around security, architecture, development practices and vision is genuinely welcome.

Discord: **alex_24589**

## License

MIT — see [LICENSE](LICENSE) for details.

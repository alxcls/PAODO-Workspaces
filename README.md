# PAODO Workspace

**Self-hosted AI agents you run on your own infrastructure.**

Each *workspace* is an isolated Docker container running its own ReAct loop coding agent. Make it write scripts to run and instructions to follow, then call it through the workspace chat interface or an external API. Workspaces can be wired into a graph, so agents discover each other and delegate tasks. Think of it as multiple instances of VS Code + Claude Code, each in its own sandbox environment that can be wired together for collaboration.

![Workspace overview](doc/images/DEMO_OVERVIEW.png)

## Features

- **Isolated workspaces** — one Docker container per workspace, with its own agent and `AGENTS.md` instructions, running as a restricted non-root user
- **ReAct agent** — full tool set (file read/edit/write, shell, glob, directory listing, `apt_install`, web fetch, todo list, context compaction); streams progress live and is interruptible (press escape to kill the running command)
- **File browser** — view, edit, upload, and download files from the UI, with syntax highlighting
- **HTTP API** — call any workspace's agent externally with a per-workspace API key
- **Live console** — shell output and file changes stream to the UI in real time
- **Agent network** — connect workspaces in a graph; agents discover and call each other to build multi-agent workflows
- **Shared drives** — shared storage space you connect to multiple workspaces from the graph user interface. Each agents can then download, or share files files through it for multi-agent collaboration requirement shared materials.

## Quick start

**Requirements:** Node.js 20+, [Docker](https://docs.docker.com/get-docker/) (running), and an OpenAI, Anthropic, or DeepSeek API key.

```bash
git clone https://github.com/alxcls/PAODO_WS.git
cd PAODO_WS
npm install
cp .env.example .env          # set LLM_PROVIDER and the matching API key
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The workspace Docker image is built automatically on first run.

For VPS deployment, see the [deploy guide](deploy/README.md).

## How it works

The diagram shows the full picture: each workspace runs an isolated agent loop in its own Docker sandbox, reachable from the chat UI or an external app, with workspaces calling each other through typed contracts.

![Architectural representation of the main functionality](doc/images/loop.png)

`server.ts` boots a Node.js HTTP server that mounts Next.js plus a WebSocket server on one port, so shell output and file events stream over `/ws` without a separate process. Requests hit Next.js API routes, which run the ReAct loop in [`lib/agent/runner.ts`](lib/agent/runner.ts) and stream events back over SSE.

Every sandboxed tool call — file ops, glob, shell, package installs — runs inside a per-workspace Docker container (`ws_<id>`) as a restricted non-root user, with only that workspace's directory mounted. Containers start on demand and stop after an idle timeout.

Persistence is lightweight: workspace metadata and the network graph live as JSON under `data/`; conversation history is in-memory and resets on restart.

For the full architecture, see [`doc/`](doc/).

The agent runs a ReAct loop with the following tools:

- **Files** — `file_read` · `file_write` · `file_edit` · `list_directory` · `glob`
- **System** — `execute_command` · `apt_install` · `http_get`
- **Session** — `todo_write` · `compact_context` · `workspace_history` · `workspace_restore`
- **Agent network** — `list_agents` · `call_agent`
- **Shared drives** — `drive_ls` · `drive_read` · `drive_download` · `drive_upload` · `drive_delete`

## Agent network

Workspaces can call each other. The network page connects them into a directed graph; an edge **A → B** lets A's agent invoke B's. Agents find their neighbors with `list_agents` and call them with `call_agent`.

Calls are **contract-first**: each workspace publishes typed *skills* (`skills/*.json`), and the platform validates the caller's input and the callee's output against the skill's schema. The callee runs in a fresh, isolated conversation. No graph edge, no call.

*A newsroom fleet, the editor delegates to specialists who collaborate through one shared drive :*

![Agent Network](doc/images/NETWORK_EXAMPLE.png)

## API access

Enable API access from the workspace panel to generate a key, then:

```bash
curl -X POST http://localhost:<port>/api/workspaces/<id>/agent \
  -H "Authorization: Bearer <api-key>" \
  -d '{"message": "list all files and summarize what this workspace does"}'
```

The response is a Server-Sent Events stream of progress events (`tool_start`, `tool_end`, …), ending in a single `response` event that carries the final answer, then `done`.

## Project structure

```
server.ts                Custom entry: Next.js + WebSocket on one port
Dockerfile(.workspace)   Platform image / per-workspace sandbox image
app/api/                 REST + SSE endpoints, agent network API
lib/agent/               ReAct loop, system prompt, one file per tool
lib/infra/               Persistence + runtime (store, containers, WS hub)
components/              UI panels (chat, file tree, console, graph editor)
data/                    Runtime state (gitignored)
doc/                     Architecture docs, PRDs, ADRs
```

## Known limitations

- **No automatic compaction** — the agent compacts context on demand via `compact_context`, but never automatically by size.
- **History not persisted** — resets on restart; workspace files are the long-term memory.
- **History varies by entry point** — browser chat is stateful per tab; the external API and agent-to-agent calls are stateless (each call starts fresh).
- **No file write queue** — concurrent writes to the same file can overwrite each other under load.
- **No image reading** — the agent handles images as raw files but can't see their content.

## Roadmap

Automatic (size-triggered) compaction · budget monitoring · scheduled triggers · database storage and tools.

## Contributing

This is a personal project to build a power tool for small CLI agent services. Help or opinion about the project is genuinely welcome.

Discord: **alex_24589**

## License

MIT — see [LICENSE](LICENSE).

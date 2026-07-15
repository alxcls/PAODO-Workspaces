# PAODO Workspace

**PAODO turns coding agents into controlled, callable AI services.**

Each *workspace* is an isolated Docker container running its own ReAct loop coding agent. Make it write scripts to run and instructions to follow, then call it through the workspace chat interface or an external API. Workspaces can be wired into a graph, so agents discover each other and delegate tasks. Think of it as multiple instances of VS Code + Claude Code, each in its own sandbox environment that can be wired together for collaboration.

![Workspace overview](doc/images/DEMO_OVERVIEW.png)

## Features

- **Isolated workspaces** — one Docker container per workspace, with its own agent and `AGENTS.md` instructions, running as a restricted non-root user

- **ReAct agent** — full tool set (file read/edit/write, shell, glob, directory listing, `apt_install`, web fetch, todo list, context compaction); streams progress live and is interruptible (press escape to kill the running command)

- **File browser** — view, edit, upload, and download files from the UI, with syntax highlighting

- **HTTP API** — call any workspace's agent externally with a per-workspace API key

- **Workspace MCP** — expose selected workspace skills as MCP tools through a per-workspace, independently revocable access key

- **Scheduled triggers** — run a workspace agent on a recurring schedule

- **Live console** — shell output and file changes stream to the UI in real time

- **Per-workspace secrets** — give each workspace its own third-party API keys; a credential proxy injects the real values into outbound requests so the keys never reach the agent or its container

- **Agent network** — connect specialist workspaces so one agent can call another through defined, validated skills

- **Shared drives** — connect shared storage to selected workspaces so agents can exchange files and collaborate on the same materials.

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

Each workspace runs in its own Docker sandbox and can be used through the chat UI or external API. Connected workspaces can call each other through defined input/output contracts.

![Architectural representation of the main functionality](doc/images/loop.png)

`server.ts` boots a Node.js HTTP server that mounts Next.js plus a WebSocket server on one port, so shell output and file events stream over `/ws` without a separate process. Requests hit Next.js API routes, which run the ReAct loop in [`lib/agent/runner.ts`](lib/agent/runner.ts) and stream events back over SSE.

Every sandboxed tool call — file ops, glob, shell, package installs — runs inside a per-workspace Docker container (`ws_<id>`) as a restricted non-root user, with only that workspace's directory mounted. Containers start on demand and stop after an idle timeout.

Workspace metadata and network configuration are stored as JSON files under `data/`.

For the full architecture, see [`doc/`](doc/).

The agent runs a ReAct loop with the following tools:

- **Files** — `file_read` · `file_write` · `file_edit` · `list_directory` · `glob`
- **System** — `execute_command` · `stop_task` · `apt_install` · `http_get`
- **Session** — `todo_write` · `compact_context` · `workspace_history` · `workspace_restore`
- **Agent network** — `list_agents` · `call_agent`
- **Shared drives** — `drive_ls` · `drive_read` · `drive_download` · `drive_upload` · `drive_delete`

## Agent network

Workspaces can call each other. The network page connects them into a directed graph; an edge **A → B** lets A's agent invoke B's. Agents find their neighbors with `list_agents` and call them with `call_agent`.

Calls are **contract-first**: each workspace publishes typed *skills* (`.skills/*.json`), and the platform validates the caller's input and the callee's output against the skill's schema. The callee runs in a fresh, isolated conversation. No graph edge, no call.

*Example: a newsroom editor agent delegates research and writing to specialist agents that share a common drive.*

![Agent Network](doc/images/NETWORK_EXAMPLE.png)

## API access

Enable API access from the workspace panel to generate a key, then:

```bash
curl -X POST http://localhost:<port>/api/workspaces/<id>/agent \
  -H "Authorization: Bearer <api-key>" \
  -d '{"message": "list all files and summarize what this workspace does"}'
```

The response is a Server-Sent Events stream of progress events (`tool_start`, `tool_end`, …), ending in a single `response` event that carries the final answer, then `done`.

Each API call creates a conversation visible in the workspace UI and returns its id in the
`X-Conversation-Id` response header (also included in the terminal SSE events). To continue that
same conversation on a later call, include it in the request body:

```json
{ "message": "Continue with the next step", "conversationId": "<conversation-id>" }
```

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

- **No file write queue** — concurrent writes to the same file can overwrite each other under load.

- **No image reading** — the agent handles images as raw files but can't see their content.

## Roadmap

Automatic (size-triggered) compaction · budget monitoring · database storage and tools.

## Contributing

This is a personal project to build a power tool for small CLI agent services. Help or opinion about the project is genuinely welcome.

Discord: **alex_24589**

## License

MIT — see [LICENSE](LICENSE).

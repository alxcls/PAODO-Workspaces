# CLAUDE.md

## Codebase graph query

Use this tool to understand file relationships before making changes. `query-graph` builds the graph on the fly each time, so no pre-build step is needed.

```bash
npm run query-graph -- summary                                 # overview: file counts, layers, most-used files, isolated files
npm run query-graph -- file <relpath>                          # one file: exports, what it uses, what uses it
npm run query-graph -- layer <name>                            # all files in a layer with their exports and usage count
npm run query-graph -- full                                    # full graph as JSON (nodes + edges)
```

To pre-build the visual graph without opening a browser (e.g. in CI):
```bash
npm run build-graph
```

Valid layer names: `entry`, `infra`, `agent`, `tools`, `api`, `pages`, `components`, `types`, `other`

**Example — before touching an infra file:**
```bash
npm run query-graph -- file lib/infra/workspaceStore.ts
```
Shows exactly which files import it and which symbols they use, so you know the blast radius of a change.

**To regenerate the visual graph** (opens in browser):
```bash
npm run graph
```

## App overview

A self-hosted AI coding agent platform built on Next.js + a custom Node.js HTTP server. Users create browser-accessible workspaces where a ReAct-loop agent (backed by OpenAI via LangChain) can browse files, run shell commands, edit code, and fetch URLs — all sandboxed to isolated directories under `./data/`. Think a stripped-down Cursor/Replit you deploy yourself.

The agent loop (`lib/agent/runner.ts`) is an AsyncGenerator that streams `AgentEvent` objects over SSE. Real-time shell output and file change notifications flow separately over WebSockets (`/ws`). Persistence is lightweight: workspace metadata and API keys are stored in JSON files; todo lists are in-memory only and reset on restart. Each workspace gets its own API key, conversation history, and an `AGENTS.md` file injected into the system prompt for per-workspace customization.

Project docs: product requirement documents (PRDs) live under `doc/prd/` and are organized into `doc/prd/draft/`, `doc/prd/accepted/`, and `doc/prd/archived/` so you can find proposals, accepted specs, and superseded items. Architecture Decision Records (ADRs) live under `doc/adr/` (see `doc/adr/README.md`) and capture significant technical choices; use `doc/adr/adr-template.md` when adding one. PRD and ADR templates are in `doc/prd/prd-template.md` and `doc/adr/adr-template.md`.

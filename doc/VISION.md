# Product Vision

PAODO WS is a self-hosted platform for running small, AI-managed services in isolated workspaces that can communicate with each other.

this project came from a simple belief: anyone who thinks like a problem-solver can become an AI powered citizen developer turn their business requirements into a running service with a CLI AI agent supporting design, development, maintenance and execution.

We think the next generation of business tools won't be Excel spreadsheets and PowerPoint decks they'll be small apps for citizen developers collaborating with CLI agent.

## Core idea

AI is isolated and grounded inside a workspace which has a file and folder hierarchy and a terminal You describe what you want, it writes the terminal commands, the code, runs the code. 

The agent handles the terminal. You handle the intent.

workspace agents can then be organized in a controlled DAG according to the network architecture so they can call each other as tools. 

Any workspace agent can be triggered from an external tool, for example we can embed it into a chatbot which can abstract the workspace files and separate concerns.

## Functionalities

- **Isolated workspaces** — each service runs in its own container with its own file system, agent, conversation history, and API key

Benefit : Isolation allows control of each workspace agent and modularity with the addition of the agent network functionality

- **Real-time console** — every command the agent runs streams live to the browser so you always know what is happening

Benefit : full observability of what your service is doing, directly in the browser, as it happens

- **Full agent toolset** — the agent can read, write, and edit files, run shell commands, browse the web, and manage a task list

Benefit : Agent has every tool required to manipulate data inside it's isolated workspace

- **File locks** — mark any file or folder read-only to protect it from agent edits; useful for credentials, config, or outputs only the service itself should write

Benefit : protect critical data and configuration from accidental changes so you can let the agent work autonomously with confidence

- **Agent network** — connect workspaces in a directed graph so agents can delegate tasks to each other. Calls are contract-first: each workspace publishes **skills** — typed actions with enforced input and output schemas — so an orchestrator agent can route work to specialist agents below it and rely on what comes back.

Benefit : build complex workflows by wiring together workspaces, each with a single responsibility, while staying in control of which agent can talk to which — and trusting the result because the contract is enforced, not assumed

- **API access** — every workspace exposes an HTTP endpoint so external systems can trigger the agent programmatically

Benefit : plug your service into any existing tool, chatbot, or workflow without rebuilding enabling separation of concerns

- **File visualization** — Some format such as Markdown, JSON, and HTML files open as clean readable documents so every output your service generates is immediately understandable by non-technical population

## The future of work

Today a business process lives in a spreadsheet a person babysits and a deck that explains it. We think it becomes a small living service: grounded in its own data and scripts, run by an agent, callable on demand, and able to collaborate with other services the same way teams of people do.

The metaphor is an organization, not a program:

- A **workspace** is an employee — it has its own desk (files), its own tools (terminal), its own expertise (data + `AGENTS.md`), and it does one job well.
- **Skills** are its job description — typed contracts that say exactly what it can be asked for and what it returns, so colleagues can rely on it without reading its mind.
- The **agent network** is the org chart — who may ask whom, with an orchestrator routing work to the specialists below it.
- **Shared drives** (on the roadmap) are the shared workspace — the SharePoint where agents drop artifacts for each other to pick up, so collaboration outlives any single request.

The citizen developer's job shifts from *doing the work* to *designing the organization*: defining intents, contracts, and who-talks-to-whom — then letting a fleet of grounded agents run it. You handle the intent and the structure. The agents handle the terminal, the data, and the handoffs.

And because every agent is a real isolated environment you self-host — not a shared sandbox — this organization runs on infrastructure you control, with your data, your models, your rules.



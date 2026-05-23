# Product Vision

PAODO WS is a self-hosted platform for running small, AI-managed services in isolated workspaces that can communicate with each other.

this project came from a simple belief: anyone who thinks like a problem-solver can turn their business requirements into a running service with a CLI AI agent supporting design, development, maintenance and execution.

We think the next generation of business tools won't be Excel spreadsheets and PowerPoint decks they'll be small apps for citizen developers collaborating with CLI agent.

## Core idea

AI is isolated and grounded inside a workspace which has a file and folder hierarchy and a terminal You describe what you want, it writes the code, runs it, and logs what happened. 

The console is the interface, the grounded agent and the generated files is the controled probabilistic service.

workspace agents can then be organized in a controlled DAG according to the graph architecture so they can call each other as tools. 

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

- **Agent network** — connect workspaces in a directed graph so agents can delegate tasks to each other

Benefit : build complex workflows by wiring together workspaces, each with a single responsibility, while staying in control of which agent can talk to which

- **API access** — every workspace exposes an HTTP endpoint so external systems can trigger the agent programmatically

Benefit : plug your service into any existing tool, chatbot, or workflow without rebuilding enabling separation of concerns

- **File visualization** — Some format such as Markdown, JSON, and HTML files open as clean readable documents so every output your service generates is immediately understandable by non-technical population


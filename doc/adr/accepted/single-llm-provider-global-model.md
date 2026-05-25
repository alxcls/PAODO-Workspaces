# ADR — Single LLM provider & global model config

Status: Accepted

Context
Supporting multiple LLM providers and per-workspace model selection increases complexity in configuration, billing, and testing. Early focus should be stability and simplicity.

Decision
Support OpenAI as the initial LLM provider and expose a global `OPENAI_model` environment variable. Do not support per-workspace model selection or alternative providers in the first iteration.

Consequences
- Simpler configuration, fewer integration testing vectors, and straightforward billing handling.
- Limits advanced users who may want different models per workspace.
- Leaves an obvious extension point to add provider abstraction and per-workspace overrides later.

Alternatives considered
- Provider-agnostic adapter from day one (higher engineering cost).
- Per-workspace model overrides (flexible but increases surface area for testing and config).

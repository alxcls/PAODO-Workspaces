# PRD — Third-Party API Keys

**Status:** Shipped  
**Author:** @alxcls  
**Related:** [VISION.md](../VISION.md)

---

## Problem

Workspace agents often need to call third-party services (OpenAI, Stripe, an internal API…) that require a secret key. The obvious way — pasting the key into a file or an environment variable inside the workspace — means the key lives where the agent can read it, print it, or leak it into logs and conversations. Users need their agent to *use* a key without the value sitting in a place it can casually read or accidentally spill.

This is a **leak-resistance** control, not an airtight vault — see [Threat model](#threat-model--limitations). It keeps the value out of the agent's context and out of accidental disclosure (printing an env var, echoing a file, logging a request). It does not, and cannot, stop a determined or prompt-injected agent from round-tripping the key through a cooperating endpoint.

## Goals

- Let a user attach a third-party API key to a workspace so the agent can call an external service on their behalf
- Keep the real key value outside the workspace — the agent works with a placeholder, so the value is not there to read, print, or accidentally log
- Restrict each key to the one service it belongs to, so it isn't substituted into requests to any other host
- Let the user manage keys (add, list, delete) from the workspace settings

## Non-goals

- Sharing keys across workspaces — each key belongs to one workspace
- Storing keys the agent needs to compute with directly (e.g. request signing), which can't be swapped in transparently
- A secrets marketplace or rotation/expiry scheduling — keys are added and removed manually

## User stories

> As a citizen developer, I want my workspace agent to call the OpenAI API without me putting my real key in a file the agent can read.

> As a citizen developer, I want a careless agent to be unable to print my API key by accident, because inside the workspace it only ever holds a placeholder — not the real value.

> As a citizen developer, I want each key locked to a single host, so its real value is never substituted into a request to some other address.

> As a citizen developer, I want to add and remove a workspace's keys from its settings page.

## Requirements

### Must have

- User can add a key to a workspace by giving it a name, a value, and the host it may be used with
- The real value is stored outside the workspace and is never returned by the API or injected into the agent's context — only the name and host are ever shown back
- Inside the workspace the agent sees a placeholder, not the real value; the real value is substituted in only on outbound requests to the allowed host
- The allowed host is matched **exactly** — a key scoped to `api.openai.com` is never substituted into a request to any other host, including sibling subdomains like `evil.openai.com`
- Requests to any other host never receive the real value
- User can list a workspace's keys (names and hosts only) and delete any of them
- Deleting a workspace removes all of its keys

### Nice to have

- UI in the workspace settings to add, list, and delete keys, with a clear note that the key is kept out of the agent's context (leak-resistant, not an airtight vault)

## Threat model / limitations

This feature is a **hygiene / leak-resistance control**. It is worth being precise about what it does and does not stop.

**What it stops (the design goal):** accidental disclosure. The container only ever holds an opaque placeholder token, never the real value. If the agent prints its environment, echoes the token into a file, logs a request, or bypasses the proxy entirely, only the token travels — upstream rejects it and the real value never leaves the host. The proxy also never substitutes over plain HTTP (which would expose the value to an on-path observer) and injects only for the exact allowed host.

**What it does NOT stop (intrinsic limits):**

- **Reflective exfiltration by a determined or prompt-injected agent.** Because the agent directs requests to the allowed host and the proxy substitutes the token *anywhere* it appears in the request, an agent can send the token to any endpoint on the allowed host that stores-and-returns caller-supplied data (create a resource whose name/description is the token, then read it back) or that echoes the request. The server persists the real value and returns it verbatim (the proxy only rewrites *requests*), so the agent recovers the plaintext. This cannot be patched away — it is inherent to letting the agent carry the real secret to a service it also controls. Treat the guarantee as "the value is kept out of the agent's context and out of accidental logs/echoes," not "the agent can never obtain it."
- **Secrets are plaintext at rest**, and the MITM CA private key lives on disk under `data/.proxy-ca/`. A host-read compromise (anyone who can read the VPS filesystem) yields every stored key and the ability to MITM all workspace TLS. This is accepted because the store lives outside the workspace/agent boundary the feature defends; it is not defended against a compromised *host*. There is no KMS/encryption-at-rest today.
- **Signed / computed auth can't be proxied.** Schemes where the secret is consumed by a computation before transmission (AWS SigV4 / HMAC request signing, SCRAM DB auth) have no literal token on the wire to swap, so those secrets must live in the container and are out of scope here.
- **Not-yet-supported request shapes to an allowed host.** The MITM is a hand-rolled HTTP/1.1 path. It does not currently handle a client that *forces* HTTP/2, a WebSocket `Upgrade`, or pipelined requests to an allowed host — such requests won't get substitution (they fail closed rather than leak). `Expect: 100-continue` **is** handled.

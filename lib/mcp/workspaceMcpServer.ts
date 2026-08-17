// Builds the MCP surface for a single workspace: it exposes every skill the workspace declares in
// .skills/ as an MCP tool and runs them through the same validated skill path A2A uses
// (executeSkill), bypassing only the Agent Graph check since an external MCP client is not
// a connected workspace. Kept transport-agnostic so the list/call logic is unit-testable; the HTTP
// wiring lives in the route handler.
//
// There is no per-skill publication step: the endpoint being enabled plus a valid bearer secret IS
// the authorization decision, exactly as an Agent Graph edge is for A2A. `.skills/` is therefore
// the single source of truth, and it is read live on every request — a skill the workspace agent
// writes is callable immediately, one it deletes stops being listed and stops being callable.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadSkills } from "@/lib/skills/store";
import { executeSkill } from "../agent/skills/executeSkill";
import { getStore, getContainers } from "../infra/services";
import { createLogger } from "../infra/logger";
import type { SkillDefinition } from "@/lib/skills/types";

const log = createLogger("workspaceMcp");

// Seams so the list/call logic can be unit-tested without touching disk or a real agent run.
// Production wires the concrete implementations.
export interface WorkspaceMcpDeps {
  loadSkillsFn?: (dir: string) => Promise<SkillDefinition[]>;
  getWorkspaceDir?: (workspaceId: string) => string | undefined;
  executeSkillFn?: typeof executeSkill;
}

function exposedSkills(workspaceId: string, deps: WorkspaceMcpDeps): Promise<SkillDefinition[]> {
  const dir = (deps.getWorkspaceDir ?? ((id) => getStore().getWorkspace(id)?.dir))(workspaceId);
  if (!dir) return Promise.resolve([]);
  return (deps.loadSkillsFn ?? loadSkills)(dir);
}

/** The workspace's declared skills as MCP tool descriptors (id → name, plus schemas). */
export async function listWorkspaceMcpTools(workspaceId: string, deps: WorkspaceMcpDeps = {}): Promise<Tool[]> {
  const skills = await exposedSkills(workspaceId, deps);
  return skills.map((s) => ({
    name: s.id,
    description: s.description || undefined,
    inputSchema: s.input as Tool["inputSchema"],
    outputSchema: s.output as Tool["outputSchema"],
  }));
}

/** Runs a declared skill and maps the SkillCallResult onto an MCP tool result. */
export async function callWorkspaceMcpTool(
  workspaceId: string,
  name: string,
  args: Record<string, unknown>,
  deps: WorkspaceMcpDeps = {},
): Promise<CallToolResult> {
  // Resolved from the same live read tools/list uses, so a skill the agent has deleted since the
  // client cached its list is uncallable rather than merely unlisted.
  const skills = await exposedSkills(workspaceId, deps);
  const skill = skills.find((s) => s.id === name);
  if (!skill) {
    if (!skills.length) {
      return toolError(`Unknown tool "${name}". This workspace currently exposes no MCP tools.`);
    }
    const available = skills.map((s) => `"${s.id}"`).join(", ");
    return toolError(`Unknown tool "${name}". Available tools: ${available}.`);
  }

  let result;
  try {
    const exec = deps.executeSkillFn ?? executeSkill;
    result = await exec(workspaceId, `mcp:${workspaceId}`, name, args ?? {}, {
      // The MCP client is not a workspace with a graph edge; the credential already authorized it, so
      // skip the Agent Graph DAG check. NOT_CONNECTED therefore cannot occur.
      canCallFn: () => true,
      store: getStore(),
      containers: getContainers(),
      origin: "mcp",
      resolvedSkill: skill,
    });
  } catch (err) {
    // Never let an execution exception escape the MCP request handler: doing so can leave a
    // Streamable-HTTP client with a closed connection and no JSON-RPC response.
    log.error(
      {
        event: "workspace_mcp_skill_execution_threw",
        outcome: "tool_error_returned",
        workspaceId,
        skill: name,
        err,
      },
      "workspace MCP skill execution threw",
    );
    return toolError("[EXECUTION_ERROR] The skill could not be completed.");
  }

  if (result.state === "completed") {
    return {
      structuredContent: result.output,
      content: [{ type: "text", text: JSON.stringify(result.output) }],
    };
  }

  // Every failure (NEEDS_INPUT included, per the PRD) surfaces as a normal MCP tool error carrying
  // the machine-readable code plus the human message.
  log.warn(
    {
      event: "workspace_mcp_tool_call_failed",
      outcome: "tool_error_returned",
      workspaceId,
      skill: name,
      code: result.code,
    },
    "workspace MCP tool call failed",
  );
  return toolError(`[${result.code}] ${result.message}`);
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Builds a fresh low-level MCP Server bound to one workspace, with tools/list and tools/call wired
 * to the workspace's declared skills. A new instance is created per request in the stateless HTTP
 * handler, so nothing here holds cross-request state.
 */
export function buildWorkspaceMcpServer(workspaceId: string, deps: WorkspaceMcpDeps = {}): Server {
  const description = getStore().getWorkspace(workspaceId)?.description?.trim();
  const server = new Server(
    { name: `paodo-workspace-${workspaceId}`, version: "1.0.0" },
    {
      capabilities: { tools: {} },
      // Returned in the MCP initialize response, giving clients workspace-level context without
      // duplicating it into each tool description.
      instructions: description || undefined,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await listWorkspaceMcpTools(workspaceId, deps),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callWorkspaceMcpTool(workspaceId, req.params.name, req.params.arguments ?? {}, deps),
  );

  return server;
}

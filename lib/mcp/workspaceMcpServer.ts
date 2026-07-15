// Builds the MCP surface for a single workspace: it exposes exactly the workspace's *selected*
// (published) skills as MCP tools and runs them through the same validated skill path A2A uses
// (executeSkill), bypassing only the Agent-Network graph check since an external MCP client is not
// a connected workspace. Kept transport-agnostic so the list/call logic is unit-testable; the HTTP
// wiring lives in the route handler.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadSkills } from "../workspace/skillStore";
import { getState } from "../infra/security/mcpConfigStore";
import { executeSkill } from "../agent/skills/executeSkill";
import { getStore, getContainers } from "../infra/services";
import { createLogger } from "../infra/logger";
import type { SkillDefinition } from "../workspace/skillTypes";

const log = createLogger("workspaceMcp");

// Hard ceiling on a single tool call, mirroring AgentCallTool's 5-minute cap.
const CALL_TIMEOUT_MS = 300_000;

// Seams so the list/call logic can be unit-tested without touching disk, the config store, or a
// real agent run. Production wires the concrete implementations.
export interface WorkspaceMcpDeps {
  loadSkillsFn?: (dir: string) => Promise<SkillDefinition[]>;
  getSelectedSkillIds?: (workspaceId: string) => string[];
  getWorkspaceDir?: (workspaceId: string) => string | undefined;
  executeSkillFn?: typeof executeSkill;
}

function selectedSkills(workspaceId: string, deps: WorkspaceMcpDeps): Promise<SkillDefinition[]> {
  const dir = (deps.getWorkspaceDir ?? ((id) => getStore().getWorkspace(id)?.dir))(workspaceId);
  if (!dir) return Promise.resolve([]);
  const selected = new Set((deps.getSelectedSkillIds ?? ((id) => getState(id).selectedSkillIds))(workspaceId));
  return (deps.loadSkillsFn ?? loadSkills)(dir).then((skills) => skills.filter((s) => selected.has(s.id)));
}

/** The workspace's selected skills as MCP tool descriptors (id → name, plus schemas). */
export async function listWorkspaceMcpTools(
  workspaceId: string,
  deps: WorkspaceMcpDeps = {},
): Promise<Tool[]> {
  const skills = await selectedSkills(workspaceId, deps);
  return skills.map((s) => ({
    name: s.id,
    description: s.description || undefined,
    inputSchema: s.input as Tool["inputSchema"],
    outputSchema: s.output as Tool["outputSchema"],
  }));
}

/** Runs a selected skill and maps the SkillCallResult onto an MCP tool result. */
export async function callWorkspaceMcpTool(
  workspaceId: string,
  name: string,
  args: Record<string, unknown>,
  deps: WorkspaceMcpDeps = {},
): Promise<CallToolResult> {
  // A tool that exists in the workspace but was not selected must be invisible AND uncallable, so we
  // gate on the selection set rather than letting executeSkill see every skill on disk.
  const skills = await selectedSkills(workspaceId, deps);
  const skill = skills.find((s) => s.id === name);
  if (!skill) {
    if (!skills.length) {
      return toolError(`Unknown tool "${name}". This workspace currently exposes no MCP tools.`);
    }
    const published = skills.map((s) => `"${s.id}"`).join(", ");
    return toolError(`Unknown tool "${name}". Published tools: ${published}.`);
  }

  let result;
  try {
    const exec = deps.executeSkillFn ?? executeSkill;
    result = await exec(workspaceId, `mcp:${workspaceId}`, name, args ?? {}, {
      // The MCP client is not a workspace with a graph edge; the credential already authorized it, so
      // skip the Agent-Network DAG check. NOT_CONNECTED therefore cannot occur.
      canCallFn: () => true,
      store: getStore(),
      containers: getContainers(),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      origin: "mcp",
      resolvedSkill: skill,
    });
  } catch (err) {
    // Never let an execution exception escape the MCP request handler: doing so can leave a
    // Streamable-HTTP client with a closed connection and no JSON-RPC response.
    log.error({ workspaceId, skill: name, err }, "workspace MCP skill execution threw");
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
  log.info({ workspaceId, skill: name, code: result.code }, "workspace mcp tool call failed");
  return toolError(`[${result.code}] ${result.message}`);
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Builds a fresh low-level MCP Server bound to one workspace, with tools/list and tools/call wired
 * to the selection-gated skill path. A new instance is created per request in the stateless HTTP
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

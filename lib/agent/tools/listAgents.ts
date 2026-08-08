// Tool that lists the agents reachable from this workspace via call_agent, with each
// workspace's declared skills (read live from its .skills/ directory) so the calling agent
// can fill in call_agent's skill + args without guessing. A reachable workspace with no
// skills is shown explicitly so the caller knows it exists but is not callable.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { getCallees } from "@/lib/agent/network/graph";
import { loadSkills } from "@/lib/skills/store";
import type { IWorkspaceReader } from "../../infra/interfaces";
import type { SkillDefinition, SkillSchema } from "@/lib/skills/types";

const schema = z.object({});

// "check-stock(sku: string, format?: string)" — `?` marks params not in the required array.
function formatInput(input: SkillSchema): string {
  const props = input.properties ?? {};
  const required = new Set(input.required ?? []);
  return Object.entries(props)
    .map(([name, p]) => `${name}${required.has(name) ? "" : "?"}: ${p.type ?? "any"}`)
    .join(", ");
}

// "{ in_stock: boolean, quantity: number }"
function formatOutput(output: SkillSchema): string {
  const props = output.properties ?? {};
  const fields = Object.entries(props).map(([name, p]) => `${name}: ${p.type ?? "any"}`);
  return fields.length ? `{ ${fields.join(", ")} }` : "{}";
}

function formatExample(schema: SkillSchema): string | null {
  if (!Array.isArray(schema.examples) || !schema.examples.length) return null;
  return JSON.stringify(schema.examples[0]);
}

export function formatSkill(skill: SkillDefinition): string {
  const desc = skill.description ? ` — ${skill.description}` : "";
  const inputExample = formatExample(skill.input);
  const outputExample = formatExample(skill.output);
  return [
    `  → ${skill.id}(${formatInput(skill.input)})${desc}`,
    `    returns: ${formatOutput(skill.output)}`,
    ...(inputExample ? [`    example input: ${inputExample}`] : []),
    ...(outputExample ? [`    example output: ${outputExample}`] : []),
  ].join("\n");
}

export class ListAgentsTool extends StructuredTool<typeof schema> {
  name = "list_agents";
  description =
    "List all agents this workspace can contact via call_agent, with each agent's declared skills (skill ids, input fields, return shape, and examples when supplied)";
  schema = schema;

  constructor(
    private readonly callerWorkspaceId: string,
    private readonly store: IWorkspaceReader,
    private readonly loadSkillsFn: typeof loadSkills = loadSkills,
  ) {
    super();
  }

  protected async _call(_input: z.infer<typeof schema>): Promise<string> {
    const calleeIds = getCallees(this.callerWorkspaceId);
    if (!calleeIds.length) return "No agents connected to this workspace.";

    const sections = await Promise.all(
      calleeIds.map(async (id) => {
        const ws = this.store.getWorkspace(id);
        if (!ws) return `- ${id}`;
        const skills = await this.loadSkillsFn(ws.dir);
        if (!skills.length) return `- ${ws.name}\n  (no skills declared — not callable)`;
        return `- ${ws.name}\n${skills.map(formatSkill).join("\n")}`;
      }),
    );

    return `Connected agents:\n\n${sections.join("\n\n")}`;
  }
}

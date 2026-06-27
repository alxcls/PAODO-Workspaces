// Single source for the per-workspace dynamic pieces of the system prompt: the workspace's
// AGENTS.md and its connected-drives block. Every path that builds a system prompt for a
// workspace gathers its inputs here, so a workspace that has a drive connected always gets the
// drive instructions in its prompt — no path can silently miss them.

import fs from "fs";
import path from "path";
import { createLogger } from "../infra/logger";
import { getDrivesForWorkspace, formatDriveLine } from "../workspace/driveStore";
import { isCallee } from "../workspace/workspaceGraph";

const log = createLogger("promptContext");

export interface WorkspacePromptInputs {
  agentsContent?: string;
  drivesInfo?: string;
  calleeInfo?: string;
}

// Injected into the system prompt only when this workspace is a callee (another workspace
// can call it). Caller-only workspaces never see it. Drive exchange is intentionally NOT
// here — that guidance is drive-gated and lives in the connected-drives block below.
const CALLEE_GUIDANCE = `# Being called by other agents
Other agents can call this workspace through skills declared in the \`skills/\` folder —
one JSON file per skill, with typed input (\`parameters\`) and output (\`output\`) schemas the
platform enforces on every call. No skills means this workspace is not callable. To declare
one, copy \`skills/example-skill.json.template\` to \`skills/<skill-id>.json\` and edit it (the
\`.template\` file itself is ignored).`;

function readAgentsMd(workspaceDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf-8").trim();
  } catch {
    log.debug(`AGENTS.md not found in ${workspaceDir} — skipping`);
    return undefined;
  }
}

// The drive-exchange-in-skill-contract nudge lives here (drive-gated) rather than in the
// example template, which every callee gets regardless of drives: telling a drive-less
// workspace to add drive_id/path fields to its skills would make no sense. Appended only
// when the workspace is BOTH drive-connected AND a callee — the only case where it declares
// skills that could carry files.
const SKILL_DRIVE_CONTRACT_NUDGE = `When you declare a skill that exchanges files, add optional drive_id + input_path fields to its parameters and drive_id + output_path fields to its output, so callers hand off and receive files as drive pointers instead of inline contents.`;

function buildDrivesInfo(workspaceId: string, calleeWorkspace: boolean): string | undefined {
  const drives = getDrivesForWorkspace(workspaceId);
  if (!drives.length) return undefined;
  const list = drives.map(formatDriveLine).join("\n");
  return `# Connected drives
Your workspace is your local machine. Drives are shared spaces — pull files to work on them, push results back, using your drive tools:
${list}
When handing work to another agent, pass the drive id and the file path — not the file contents.
After uploading a file to a drive, delete your local copy so no stale copy is left behind.
After downloading a file from a drive, delete your local copy once you are done with it so no stale copy is left behind.${calleeWorkspace ? `\n${SKILL_DRIVE_CONTRACT_NUDGE}` : ""}`;
}

// Gathers everything per-workspace the system prompt needs. Pure read I/O; safe to call per request.
export function buildWorkspacePromptInputs(workspaceId: string, workspaceDir: string): WorkspacePromptInputs {
  const calleeWorkspace = isCallee(workspaceId);
  return {
    agentsContent: readAgentsMd(workspaceDir),
    drivesInfo: buildDrivesInfo(workspaceId, calleeWorkspace),
    calleeInfo: calleeWorkspace ? CALLEE_GUIDANCE : undefined,
  };
}

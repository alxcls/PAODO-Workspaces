// Single source for the per-workspace dynamic pieces of the system prompt: the workspace's
// AGENTS.md and its connected-drives block. Every path that builds a system prompt for a
// workspace gathers its inputs here, so a workspace that has a drive connected always gets the
// drive instructions in its prompt — no path can silently miss them.

import fs from "fs";
import path from "path";
import { createLogger } from "../infra/logger";
import { getDrivesForWorkspace, formatDriveLine } from "../workspace/driveStore";
import { listSecretMeta } from "../infra/security/workspaceSecretStore";
import { getContainers, getStore } from "../infra/services";

const log = createLogger("promptContext");

export interface WorkspacePromptInputs {
  agentsContent?: string;
  networkInfo?: string;
  drivesInfo?: string;
  secretsInfo?: string;
  backgroundTasksInfo?: string;
}

function readAgentsMd(workspaceDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf-8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log.debug({ workspaceDir }, "AGENTS.md not found — skipping");
    } else {
      log.warn({ err, workspaceDir }, "failed to read AGENTS.md — workspace instructions omitted");
    }
    return undefined;
  }
}

// Always returned (never undefined) — unlike the other blocks below, which omit themselves when
// there's nothing to say, network status is foundational capability info the agent should never be
// left to guess about, on or off.
function buildNetworkInfo(workspaceId: string): string {
  const enabled = getStore().getWorkspace(workspaceId)?.internetAccess ?? true;
  return enabled
    ? `# Internet access
This workspace has internet access. \`http_get\` fetches public URLs; \`apt_install\` installs system packages; \`npm\`/\`pip3\`/\`git\` work normally from execute_command.`
    : `# Internet access — DISABLED
This workspace has NO internet access. Its container has no network route out. \`http_get\` and \`apt_install\` are not available as tools. Any \`curl\`/\`wget\`/\`npm install\`/\`pip install\`/\`git clone\` against an external host from execute_command will fail immediately — do not retry them, they cannot succeed until the workspace owner re-enables internet access in the UI. Work only with what's already in the workspace.`;
}

function buildDrivesInfo(workspaceId: string): string | undefined {
  const drives = getDrivesForWorkspace(workspaceId);
  if (!drives.length) return undefined;
  const list = drives.map(formatDriveLine).join("\n");
  return `# Connected drives
Your workspace is your local machine. Drives are shared spaces — pull files to work on them, push results back, using your drive tools:
${list}
When handing work to another agent, pass the drive id and the file path — not the file contents.
After uploading a file to a drive, delete your local copy so no stale copy is left behind.
After downloading a file from a drive, delete your local copy once you are done with it so no stale copy is left behind.`;
}

function buildSecretsInfo(workspaceId: string): string | undefined {
  // Secrets are only ever substituted on outgoing HTTPS traffic (credentialProxy.ts) — with no
  // network route out, there is no request for the proxy to inject them into, so documenting them
  // would just teach the agent to reference variables that can never resolve to anything.
  const enabled = getStore().getWorkspace(workspaceId)?.internetAccess ?? true;
  if (!enabled) return undefined;
  const secrets = listSecretMeta(workspaceId);
  if (!secrets.length) return undefined;
  const lines = secrets.map((s) => `- ${s.name} → ${s.domains.join(", ")}`).join("\n");
  return `# Available Secrets
These are injected into your shell environment as opaque proxy tokens — use them directly and never print them. The credential proxy swaps in the real value only on outgoing HTTPS requests to the listed hosts, so reference the variable normally:
${lines}
Use clients that honour the standard proxy environment variables. Do not validate a secret's format locally. If a CLI rejects it before making a request, use that service's HTTPS API or SDK instead; the proxy can substitute the token only after a request is sent.`;
}

// Running background processes (dev servers etc.) started in an earlier turn. Surfaced so a later
// run — which has no memory of a prior run's taskIds — can read their logs or stop them, and knows
// port 8080 is already taken before starting another server.
function buildBackgroundTasksInfo(workspaceId: string): string | undefined {
  const tasks = getContainers().listBackground(workspaceId);
  if (!tasks.length) return undefined;
  const lines = tasks.map((t) => `- ${t.taskId}: \`${t.command}\` → log: ${t.logFile}`).join("\n");
  return `# Running background tasks
Started earlier with execute_command(run_in_background: true) and still running. Read a task's output by tailing its log file, or stop it with the stop_task tool (e.g. to free port 8080 before restarting a server):
${lines}`;
}

// Gathers everything per-workspace the system prompt needs. Pure read I/O; safe to call per request.
export function buildWorkspacePromptInputs(workspaceId: string, workspaceDir: string): WorkspacePromptInputs {
  return {
    agentsContent: readAgentsMd(workspaceDir),
    networkInfo: buildNetworkInfo(workspaceId),
    drivesInfo: buildDrivesInfo(workspaceId),
    secretsInfo: buildSecretsInfo(workspaceId),
    backgroundTasksInfo: buildBackgroundTasksInfo(workspaceId),
  };
}

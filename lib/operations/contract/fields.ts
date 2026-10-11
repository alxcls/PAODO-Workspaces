// Everything a programmatic caller would otherwise restate: settable fields, channels, limits, vocabularies
// and what replies mean — each built from the constant or type its own code enforces, so no copy can age.
import { MAX_DRIVE_LISTING_ENTRIES } from "@/lib/infra/limits";
import { CREDENTIAL_CHANNELS, PLATFORM_CONTRACT_VERSION } from "@/lib/infra/security/platformAccessPolicy";
import { SESSION_PREVIEW_MAX_CHARS } from "@/lib/operations/conversations/sessions";
import { scheduleTickMs } from "@/lib/schedules/tick";
import type { RunStatus } from "@/lib/schedules/types";
import { MAX_DASHBOARD_TURNS, type SessionOrigin, type SessionStatus, type ToolStatus } from "@/lib/usage/types";
import { MAX_DRIVE_NAME_LENGTH } from "@/lib/drives/name";
import { UPDATABLE_FIELDS as DRIVE_UPDATABLE_FIELDS } from "@/lib/operations/drives/manage";
import { SCHEDULE_FIELDS } from "@/lib/operations/schedules/schedule";
import { WORKSPACE_UPDATABLE_FIELDS } from "@/lib/operations/workspace/update";
import { INTERVAL_UNITS, MAX_INTERVAL_VALUE, MAX_PROMPT_LENGTH, MIN_INTERVAL_VALUE } from "@/lib/schedules/types";
import {
  MAX_MAX_ITERATIONS,
  MAX_MAX_RUN_MINUTES,
  MAX_WORKSPACE_DESCRIPTION_LENGTH,
  MIN_MAX_ITERATIONS,
  MIN_MAX_RUN_MINUTES,
} from "@/lib/workspace/limits";
import { MAX_WORKSPACE_NAME_LENGTH } from "@/lib/workspace/name";

/**
 * One settable field. `type` is the JSON type the route expects, which is what a client that receives
 * every value as text needs in order to encode it; `values` is the closed set when there is one; `rule`
 * is the rest, in words. None of it is enforcement — the validators are — so a rule here may be looser
 * than the truth but must never contradict it.
 */
export interface ContractField {
  type: "string" | "int" | "boolean";
  values?: readonly string[];
  rule?: string;
}

/** Keyed by a route's own field list, so a field added there fails to compile until it is described here. */
type FieldsOf<Names extends readonly string[]> = Record<Names[number], ContractField>;

const MODEL_CATALOG = "from the model catalog (GET /api/models)";

const workspace: FieldsOf<typeof WORKSPACE_UPDATABLE_FIELDS> = {
  name: { type: "string", rule: `1-${MAX_WORKSPACE_NAME_LENGTH} characters` },
  description: { type: "string", rule: `0-${MAX_WORKSPACE_DESCRIPTION_LENGTH} characters` },
  llmProvider: { type: "string", rule: `a provider ${MODEL_CATALOG}` },
  llmModel: { type: "string", rule: `one of the provider's models ${MODEL_CATALOG}` },
  reasoningEffort: { type: "string", rule: `a level the model accepts ${MODEL_CATALOG}` },
  maxIterations: { type: "int", rule: `${MIN_MAX_ITERATIONS}-${MAX_MAX_ITERATIONS}` },
  maxRunMinutes: { type: "int", rule: `${MIN_MAX_RUN_MINUTES}-${MAX_MAX_RUN_MINUTES}` },
  internetAccess: { type: "boolean" },
  workspaceApiAccess: { type: "boolean" },
  workspaceMcpAccess: { type: "boolean" },
};

const LOCAL_CLOCK = "YYYY-MM-DDTHH:mm on the timezone's clock, no seconds, Z or offset";

const schedule: FieldsOf<typeof SCHEDULE_FIELDS> = {
  prompt: {
    type: "string",
    rule: `the message each run sends, at most ${MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters; required while enabled`,
  },
  intervalValue: { type: "int", rule: `${MIN_INTERVAL_VALUE}-${MAX_INTERVAL_VALUE}` },
  intervalUnit: { type: "string", values: INTERVAL_UNITS },
  startAt: { type: "string", rule: `${LOCAL_CLOCK}, e.g. 2026-10-02T09:00` },
  endAt: {
    type: "string",
    rule:
      `optional, ${LOCAL_CLOCK}, after startAt, e.g. 2026-10-31T18:00; no run starts at or after it; ` +
      "without one an enabled job runs until disabled; empty clears it",
  },
  timezone: { type: "string", rule: "standard timezone name, e.g. Europe/Paris" },
  enabled: { type: "boolean" },
};

const drive: FieldsOf<typeof DRIVE_UPDATABLE_FIELDS> = {
  name: {
    type: "string",
    rule: `1-${MAX_DRIVE_NAME_LENGTH} characters, unique across drives, no path separators and no leading dot`,
  },
  description: { type: "string", rule: "empty clears it" },
};

/** Hard numbers a caller would otherwise quote from memory. Each is the constant its code enforces. */
function limits() {
  return {
    listingEntries: MAX_DRIVE_LISTING_ENTRIES,
    sessionPreviewChars: SESSION_PREVIEW_MAX_CHARS,
    sessionListModelCalls: MAX_DASHBOARD_TURNS,
    scheduleTickSeconds: Math.round(scheduleTickMs() / 1000),
  };
}

/** Closed vocabularies, each value with what it means. Keyed by the type, so a new value must be given one. */
const sessionStatus: Record<SessionStatus, string> = {
  running: "still going",
  success: "ended well",
  failed: "ended on an error",
  cancelled: "was cancelled",
  timeout: "ran out of time",
  limit_reached: "reached its iteration limit",
  incomplete: "did not finish",
};

const sessionOrigin: Record<SessionOrigin, string> = {
  chat: "the workspace chat",
  api: "the agent API",
  mcp: "MCP",
  scheduled: "the workspace's scheduled job",
  agent: "another workspace's agent, through the graph",
  manual: "older chat sessions",
};

const toolStatus: Record<ToolStatus, string> = {
  ok: "the tool returned",
  error: "the tool failed",
  needs_input: "a call to another workspace's agent is waiting on a retry",
};

const scheduleRunStatus: Record<RunStatus, string> = { ok: "the run succeeded", error: "the run failed" };

/** `a (what a means), b (what b means)` — a vocabulary spelled out where a sentence needs it whole. */
const explained = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([value, meaning]) => `${value} (${meaning})`)
    .join(", ");

/**
 * What the replies and behaviours a caller meets mean, in sentences owned beside the code that makes
 * them true. They name fields and rules, never a client's commands: more than one client reads this.
 */
function describe() {
  const { sessionPreviewChars, sessionListModelCalls, scheduleTickSeconds } = limits();
  return {
    key: {
      workspaceApiKey: "The agent API secret, readable exactly once — when it is generated or rotated.",
      workspaceMcpKey: "The MCP secret, readable exactly once — when it is generated or rotated.",
      workspaceApiAccess: "Whether the agent API channel is open.",
      workspaceApiHasKey: "Whether an agent API key is present.",
      workspaceMcpAccess: "Whether the MCP channel is open.",
      workspaceMcpHasKey: "Whether an MCP key is present.",
      internetAccess: "The workspace's egress setting — reported here, but gates neither channel.",
      usable: "A key is usable only when its channel's access and hasKey are both true.",
    },
    schedule: {
      lastRun:
        `The last run, absent until the job has run once: at, when it ended; status, ${Object.keys(scheduleRunStatus).join(" or ")}; ` +
        "conversationId, the conversation it ran in, absent if it failed before starting; error, why it " +
        "failed, absent when ok.",
      times:
        "Every time is on timezone's clock: startAt and endAt as set, no seconds, Z or offset; nextRunAt, " +
        "createdAt and lastRun.at with their offset, e.g. 2026-10-03T09:00+02:00. endAt is null when the job " +
        "has no end.",
      timing:
        "The job fires every intervalValue intervalUnit from startAt, read on timezone's clock; the first run " +
        "is the first of those after now, and none fire at or after endAt. Due runs are looked for every " +
        `${scheduleTickSeconds} seconds; downtime and overlapping scheduled occurrences are skipped.`,
    },
    conversation: {
      id: "The conversation's own id.",
      title: "The id's first 8 characters unless one was given; never rewritten.",
      lastMessageAt: "When the conversation last saved a message, which is the order of the list.",
      running: "Whether a session is in progress in it right now.",
    },
    sessionSummary: {
      sessionId: "The session's own id.",
      startedAt: "When the session's first model call was recorded.",
      status: `One of ${explained(sessionStatus)}.`,
      userInput: `The first ${sessionPreviewChars} characters of the user's message; absent when the session recorded none.`,
      agentResponse:
        `The first ${sessionPreviewChars} characters of the agent's final answer, its last reply that called no ` +
        "tool; absent when there is none (failed, stopped or still running).",
      userInputChars: "Characters in the whole user message.",
      agentResponseChars: "Characters in the whole final answer.",
      "not listed":
        "Tokens, cost, models and the number of tool calls, which one session read alone gives. Also a session " +
        "that failed before its first model call, and the oldest sessions of a conversation past " +
        `${sessionListModelCalls.toLocaleString("en-US")} model calls.`,
    },
    session: {
      error: "Why the session stopped, when it recorded a reason; absent when it recorded none.",
      origin: `What started it: ${explained(sessionOrigin)}.`,
      models: "Every model the session used, first-seen order.",
      inputTokensUncached: "Input tokens not served from the provider's cache.",
      inputTokensCacheRead: "Input tokens read from the provider's cache.",
      outputTokensTotal: "Output tokens.",
      callCount: "How many tool calls the session made, failed ones included.",
      costByCurrency: "Cost in EUR or USD.",
      userInput: "The user's message, uncut; absent when the session recorded none.",
      agentResponse:
        "The agent's final answer, its last reply that called no tool, uncut; absent when there is none " +
        "(failed, stopped or still running).",
    },
    callSummary: {
      callId: "The call's own id.",
      timestamp:
        "When its model call was recorded, once the tools that call requested had returned; calls " +
        "requested together share one.",
      tool: "Which tool ran.",
      status: `One of ${explained(toolStatus)}.`,
      inputChars: "Characters in the call's arguments, counted as JSON text.",
      outputChars: "Characters in what the tool returned.",
      running:
        "A session still in progress lists the calls recorded so far; a call appears once every call " +
        "requested with it has returned.",
    },
    call: {
      input: "The arguments the agent gave the tool, one field each, uncut.",
      output: "What the tool returned to the agent, uncut.",
    },
    drive: {
      unique:
        "No two drives may share a name, compared case- and accent-insensitively. An agent addresses " +
        "a drive by name, so a duplicate would be reachable only by accident; a taken name is refused.",
    },
    connection: {
      pairs:
        "A drive and a workspace make a drive link, in either order; two workspaces make an agent call, the " +
        "first calling the second. Two drives are refused, and so is the same id twice.",
      agentCalls:
        "One way only, and a capability: the caller is given the delegation tools and may run the " +
        "callee, which is not true the other way round. The graph stays acyclic, so an edge that would " +
        "let a workspace be reached from its own callee is refused — connect the pair the other way.",
      driveLinks:
        "Both ends read and write the same files, and the workspace can address the drive by name from " +
        "that moment. Every workspace already on the drive sees whatever this one writes.",
      idempotent:
        "Connecting an already-connected pair is not an error and not a second connection: it answers with " +
        "the id the pair already has.",
      connectionId:
        "The id itself says which graph it is in — link_ for a drive link, call_ for an agent call. A " +
        "workspace or drive id is not one and is refused.",
    },
  };
}

export interface PlatformContract {
  version: number;
  fields: { workspace: typeof workspace; schedule: typeof schedule; drive: typeof drive };
  channels: typeof CREDENTIAL_CHANNELS;
  limits: ReturnType<typeof limits>;
  values: Record<"sessionStatus" | "sessionOrigin" | "toolStatus" | "scheduleRunStatus", Record<string, string>>;
  describe: ReturnType<typeof describe>;
}

export function getPlatformContract(): PlatformContract {
  return {
    version: PLATFORM_CONTRACT_VERSION,
    fields: { workspace, schedule, drive },
    channels: CREDENTIAL_CHANNELS,
    limits: limits(),
    values: { sessionStatus, sessionOrigin, toolStatus, scheduleRunStatus },
    describe: describe(),
  };
}

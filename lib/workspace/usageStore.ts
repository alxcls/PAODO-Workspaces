// Records per-turn LLM token usage across all workspaces, persisted to data/.usage.jsonl.
// One TurnRecord per model turn (input/output/reasoning/cache token counts + the reasoning
// text and the tool calls made, each with its output). Appended by the agent loop and read
// by the usage dashboard.
//
// Storage is append-only JSONL: a turn carries reasoning text and tool outputs, so rewriting
// the whole file on every turn (the old JSON-array approach) would be O(file). appendUsage
// appends a single line instead; the file is compacted (its last MAX_RECORDS lines kept) only
// when it grows past a high-water mark.
//
// Memory only holds the LIGHT projection (token counts + tool names/status), newest first,
// capped at MAX_RECORDS — the dashboard list reads from it. The heavy content (user input,
// reasoning, tool args + output) lives only on disk and is read back per-session by
// getSessionDetail when a drawer is opened. This keeps RAM bounded regardless of how large
// individual tool outputs get. The in-memory array is global-backed so it survives Next.js
// hot-reloads.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "../infra/paths";
import { createLogger } from "../infra/logger";

const log = createLogger("usage");

const FILE = path.join(WORKSPACES_ROOT, ".usage.jsonl");
const MAX_RECORDS = 5000;
// Compact (rewrite from the capped in-memory log) once the file holds noticeably more lines
// than we keep in memory, so append-only growth stays bounded without paying a rewrite per turn.
const COMPACT_AT = MAX_RECORDS * 1.5;

// Outcome of a tool call, decided at the source (the runner) and persisted so the dashboard
// can render it without re-parsing output. "needs_input" is the A2A non-terminal retry state.
export type ToolStatus = "ok" | "error" | "needs_input";
/** How this agent run was initiated. `manual` is retained to render historical records. */
export type SessionOrigin = "chat" | "api" | "mcp" | "scheduled" | "agent" | "manual";

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  output: string;
  status: ToolStatus;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  /** The callee/UI conversation this run belongs to, when it has one (the browser chat flow and
   *  skill calls). The external agent route runs conversation-less, so it stays undefined. Lets
   *  the dashboard deep-link a session to its conversation tab (?conversation=<id>). */
  conversationId?: string;
  workspaceId: string;
  workspaceName: string;
  /** Session origin shown in the dashboard list. */
  origin?: SessionOrigin;
  timestamp: string;
  /** The user message that started this session — set only on the session's first turn. */
  userInput?: string;
  /** The concrete model id this turn ran on (e.g. "deepseek-v4-pro"). Drives cost attribution on the
   *  dashboard. Optional so records written before this field existed still parse. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  /** The model's reasoning/thinking text for this turn (may be empty). */
  reasoningText?: string;
  /** The model's prose output for this turn: preamble alongside tool calls, or the final
   *  answer on the terminal (no-tool) turn. The agent's response to the user. */
  outputText?: string;
  toolCalls: ToolCallRecord[];
}

// The fields the agent loop produces per turn (everything except the storage identity and
// the workspace/session context). Shared by all three call sites that fold turn_usage events
// into the store (chat route, agent stream, nested skill calls) so the mapping can't drift.
export type TurnUsageFields = Omit<TurnRecord, "id" | "timestamp" | "sessionId" | "conversationId" | "workspaceId" | "workspaceName">;

export interface UsageContext {
  sessionId: string;
  conversationId?: string;
  workspaceId: string;
  workspaceName: string;
  origin?: SessionOrigin;
}

// Light projection for the dashboard list: token counts + tool names only. The heavy content
// (userInput, reasoningText, tool args + output) is loaded lazily per session via getSessionDetail.
export interface LightTurnRecord {
  id: string;
  sessionId: string;
  conversationId?: string;
  workspaceId: string;
  workspaceName: string;
  origin?: SessionOrigin;
  timestamp: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  toolCalls: Array<{ name: string; status: ToolStatus }>;
}

function toLight(r: TurnRecord): LightTurnRecord {
  return {
    id: r.id,
    sessionId: r.sessionId,
    conversationId: r.conversationId,
    workspaceId: r.workspaceId,
    workspaceName: r.workspaceName,
    origin: r.origin,
    timestamp: r.timestamp,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    reasoningTokens: r.reasoningTokens,
    cachedInputTokens: r.cachedInputTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    toolCalls: r.toolCalls.map((tc) => ({ name: tc.name, status: tc.status ?? "ok" })),
  };
}

// Reads the whole JSONL file (oldest-first) into full records. Used for per-session detail and
// for file-based compaction. Returns [] if the file is missing or unreadable.
function readAllRecords(): TurnRecord[] {
  try {
    return readFileSync(FILE, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TurnRecord);
  } catch {
    return [];
  }
}

const g = global as typeof global & { _usage?: LightTurnRecord[]; _usageFileLines?: number };
if (!g._usage) {
  // File is oldest-first (append order); the in-memory light log is newest-first to match read
  // semantics, and capped to the newest MAX_RECORDS so a large file can't bloat RAM on boot.
  const all = readAllRecords();
  g._usage = all.map(toLight).reverse().slice(0, MAX_RECORDS);
  g._usageFileLines = all.length;
}
const records = g._usage;

// Compact the file in place: keep its last MAX_RECORDS lines (the newest), atomically via
// tmp+rename. File-based so it never depends on heavy content being held in memory.
function compact() {
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const lines = readFileSync(FILE, "utf-8").split("\n").filter((l) => l.trim());
    const kept = lines.slice(-MAX_RECORDS);
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "");
    renameSync(tmp, FILE);
    g._usageFileLines = kept.length;
  } catch (err) {
    log.error({ err }, "failed to compact usage store");
  }
}

export function appendUsage(partial: Omit<TurnRecord, "id" | "timestamp">): void {
  const record: TurnRecord = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...partial,
  };
  records.unshift(toLight(record));
  if (records.length > MAX_RECORDS) records.splice(MAX_RECORDS);

  try {
    appendFileSync(FILE, JSON.stringify(record) + "\n");
    g._usageFileLines = (g._usageFileLines ?? 0) + 1;
    if ((g._usageFileLines ?? 0) > COMPACT_AT) compact();
  } catch {
    // mkdir + retry once for the first write into a fresh data dir.
    try {
      mkdirSync(path.dirname(FILE), { recursive: true });
      appendFileSync(FILE, JSON.stringify(record) + "\n");
      g._usageFileLines = (g._usageFileLines ?? 0) + 1;
    } catch (err2) {
      log.error({ err: err2 }, "failed to append usage record");
    }
  }
}

// Folds a per-turn usage event into the store under the given session/workspace context.
// The event carries a `type` discriminant on top of the turn fields; we destructure it off so
// it can't leak into the stored record, and spread the rest so this can't drift when TurnRecord
// gains a field. `append` is injectable so nested skill calls (and tests) can capture records.
export function recordTurnUsage(
  ctx: UsageContext,
  usage: TurnUsageFields & { type?: string },
  append: (r: Omit<TurnRecord, "id" | "timestamp">) => void = appendUsage,
): void {
  const fields = { ...usage };
  delete fields.type;
  append({ ...ctx, ...fields });
}

// Dashboard list payload — token counts + tool names only, no heavy content. Memory already
// holds the light projection, so this just filters it.
export function listUsageLight(workspaceId?: string): LightTurnRecord[] {
  return workspaceId ? records.filter((r) => r.workspaceId === workspaceId) : [...records];
}

// Full per-session detail (userInput, reasoning, tool args + output) for the drawer. The heavy
// content lives only on disk, so this reads the file. Returned oldest-first (chronological) so
// the drawer renders tool executions in the order they ran.
export function getSessionDetail(sessionId: string): TurnRecord[] {
  return readAllRecords().filter((r) => r.sessionId === sessionId);
}

// Full records — retained for any internal/test consumers that need everything. Reads from disk
// and returns newest-first to match the in-memory list semantics.
export function listUsage(workspaceId?: string): TurnRecord[] {
  const all = readAllRecords().reverse();
  return workspaceId ? all.filter((r) => r.workspaceId === workspaceId) : all;
}

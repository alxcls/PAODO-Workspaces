// Records per-turn LLM token usage across all workspaces, persisted to data/.usage.json.
// One TurnRecord per model turn (input/output/reasoning/cache token counts + the tool calls
// made), newest first, capped at MAX_RECORDS to bound the file. Appended by the agent loop and
// read by the usage dashboard. Backed by a global array so the in-memory log survives Next.js
// hot-reloads; writes are flushed atomically.
import { readFileSync } from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "../infra/paths";
import { atomicSaveJson } from "../infra/jsonPersist";
import { createLogger } from "../infra/logger";

const log = createLogger("usage");

const FILE = path.join(WORKSPACES_ROOT, ".usage.json");
const MAX_RECORDS = 5000;

export interface TurnRecord {
  id: string;
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

const g = global as typeof global & { _usage?: TurnRecord[] };
if (!g._usage) {
  try {
    g._usage = JSON.parse(readFileSync(FILE, "utf-8")) as TurnRecord[];
  } catch {
    g._usage = [];
  }
}
const records = g._usage;

function save() {
  try {
    atomicSaveJson(FILE, records);
  } catch (err) {
    log.error({ err }, "failed to save usage store");
  }
}

export function appendUsage(partial: Omit<TurnRecord, "id" | "timestamp">): void {
  records.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...partial,
  });
  if (records.length > MAX_RECORDS) records.splice(MAX_RECORDS);
  save();
}

export function listUsage(workspaceId?: string): TurnRecord[] {
  if (!workspaceId) return records;
  return records.filter((r) => r.workspaceId === workspaceId);
}

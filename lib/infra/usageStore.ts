import { readFileSync } from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "./paths";
import { atomicSaveJson } from "./jsonPersist";
import { createLogger } from "./logger";

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

// Persists complete per-turn usage records in SQLite.
//
// SQLite is the single source of truth: token metrics and the potentially large user input,
// reasoning, model output, tool arguments, and tool output are committed in one transaction.
// Dashboard list queries select only lightweight indexed fields; full text is fetched only when a
// session drawer is opened. The database retains all records. MAX_DASHBOARD_TURNS bounds only a
// single list response — it is not a retention policy.
import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import path from "path";
import Database from "better-sqlite3";
import { WORKSPACES_ROOT } from "../infra/paths";
import { createLogger } from "../infra/logger";
import { computeCost } from "./modelPricing";

const log = createLogger("usage");

// Runtime data is outside the application bundle; do not let Next's file tracer treat these
// deployment paths as build inputs.
const DB_FILE = path.join(/* turbopackIgnore: true */ WORKSPACES_ROOT, ".usage.db");
const LEGACY_JSONL_FILE = path.join(/* turbopackIgnore: true */ WORKSPACES_ROOT, ".usage.jsonl");
const MAX_DASHBOARD_TURNS = 5000;
const LEGACY_IMPORT_KEY = "legacy_jsonl_imported";
const LEGACY_PROJECTION_COLUMNS = [
  "id",
  "session_id",
  "conversation_id",
  "workspace_id",
  "workspace_name",
  "origin",
  "model",
  "timestamp",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_tokens",
  "reasoning_tokens",
  "cost",
  "tool_count",
  "error_code",
  "error_message",
];

// Outcome of a tool call, decided at the source (the runner) and persisted so the dashboard can
// render it without re-parsing output. "needs_input" is the A2A non-terminal retry state.
export type ToolStatus = "ok" | "error" | "needs_input";
/** How this agent run was initiated. `manual` is retained to render historical records. */
export type SessionOrigin = "chat" | "api" | "mcp" | "scheduled" | "agent" | "manual";

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  output: string;
  status: ToolStatus;
}

export interface RunErrorRecord {
  code?: string;
  message: string;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  /** The callee/UI conversation this run belongs to, when it has one. */
  conversationId?: string;
  workspaceId: string;
  workspaceName: string;
  origin?: SessionOrigin;
  timestamp: string;
  /** The user message that started this session — set only on the session's first turn. */
  userInput?: string;
  /** The concrete model id this turn ran on. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  /** USD cost frozen at write time; undefined means the model was not in the pricing catalog. */
  cost?: number;
  reasoningText?: string;
  outputText?: string;
  error?: RunErrorRecord;
  toolCalls: ToolCallRecord[];
}

export type TurnUsageFields = Omit<
  TurnRecord,
  "id" | "timestamp" | "sessionId" | "conversationId" | "workspaceId" | "workspaceName" | "cost"
>;

export interface UsageContext {
  sessionId: string;
  conversationId?: string;
  workspaceId: string;
  workspaceName: string;
  origin?: SessionOrigin;
}

/** Lightweight dashboard fields; full text and tool I/O stay in SQLite but are not selected. */
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
  cost?: number;
  error?: RunErrorRecord;
  toolCalls: Array<{ name: string; status: ToolStatus }>;
}

interface TurnRow {
  id: string;
  session_id: string;
  conversation_id: string | null;
  workspace_id: string;
  workspace_name: string;
  origin: string | null;
  timestamp: string;
  user_input: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number | null;
  reasoning_text: string | null;
  output_text: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface JoinedTurnRow extends TurnRow {
  tool_position: number | null;
  tool_name: string | null;
  tool_args_json: string | null;
  tool_output: string | null;
  tool_status: string | null;
}

interface LightJoinedRow
  extends Omit<TurnRow, "user_input" | "reasoning_text" | "output_text" | "error_code" | "error_message"> {
  error_code: string | null;
  error_message: string | null;
  tool_position: number | null;
  tool_name: string | null;
  tool_status: string | null;
}

type UsageGlobal = typeof global & {
  _usageDb?: Database.Database;
  _usageDbFile?: string;
};

const g = global as UsageGlobal;

const CREATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS usage_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS usage_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    conversation_id TEXT,
    workspace_id TEXT NOT NULL,
    workspace_name TEXT NOT NULL,
    origin TEXT,
    timestamp TEXT NOT NULL,
    user_input TEXT,
    model TEXT,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    cached_input_tokens INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    cost_usd REAL,
    reasoning_text TEXT,
    output_text TEXT,
    error_code TEXT,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS usage_tool_calls (
    turn_id TEXT NOT NULL REFERENCES usage_turns(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    output TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'needs_input')),
    PRIMARY KEY (turn_id, position)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS usage_turns_timestamp_idx
    ON usage_turns(timestamp DESC);
  CREATE INDEX IF NOT EXISTS usage_turns_workspace_timestamp_idx
    ON usage_turns(workspace_id, timestamp DESC);
  CREATE INDEX IF NOT EXISTS usage_turns_session_timestamp_idx
    ON usage_turns(session_id, timestamp ASC);
`;

const INSERT_TURN_SQL = `
  INSERT OR IGNORE INTO usage_turns (
    id, session_id, conversation_id, workspace_id, workspace_name, origin, timestamp,
    user_input, model, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens,
    cache_creation_tokens, cost_usd, reasoning_text, output_text, error_code, error_message
  ) VALUES (
    @id, @session_id, @conversation_id, @workspace_id, @workspace_name, @origin, @timestamp,
    @user_input, @model, @input_tokens, @output_tokens, @reasoning_tokens, @cached_input_tokens,
    @cache_creation_tokens, @cost_usd, @reasoning_text, @output_text, @error_code, @error_message
  )
`;

const INSERT_TOOL_SQL = `
  INSERT INTO usage_tool_calls (turn_id, position, name, args_json, output, status)
  VALUES (@turn_id, @position, @name, @args_json, @output, @status)
`;

function isToolStatus(value: unknown): value is ToolStatus {
  return value === "ok" || value === "error" || value === "needs_input";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeLegacyRecord(value: unknown): TurnRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.sessionId !== "string" ||
    typeof raw.workspaceId !== "string" ||
    typeof raw.workspaceName !== "string"
  ) {
    return undefined;
  }

  const toolCalls = Array.isArray(raw.toolCalls)
    ? raw.toolCalls.flatMap((tool): ToolCallRecord[] => {
        if (!tool || typeof tool !== "object") return [];
        const item = tool as Record<string, unknown>;
        if (typeof item.name !== "string") return [];
        return [
          {
            name: item.name,
            args:
              item.args && typeof item.args === "object" && !Array.isArray(item.args)
                ? (item.args as Record<string, unknown>)
                : {},
            output: typeof item.output === "string" ? item.output : "",
            status: isToolStatus(item.status) ? item.status : "ok",
          },
        ];
      })
    : [];

  const record: TurnRecord = {
    id: typeof raw.id === "string" ? raw.id : crypto.randomUUID(),
    sessionId: raw.sessionId,
    conversationId: typeof raw.conversationId === "string" ? raw.conversationId : undefined,
    workspaceId: raw.workspaceId,
    workspaceName: raw.workspaceName,
    origin: typeof raw.origin === "string" ? (raw.origin as SessionOrigin) : undefined,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    userInput: typeof raw.userInput === "string" ? raw.userInput : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    inputTokens: numberOrZero(raw.inputTokens),
    outputTokens: numberOrZero(raw.outputTokens),
    reasoningTokens: numberOrZero(raw.reasoningTokens),
    cachedInputTokens: numberOrZero(raw.cachedInputTokens),
    cacheCreationTokens: numberOrZero(raw.cacheCreationTokens),
    reasoningText: typeof raw.reasoningText === "string" ? raw.reasoningText : undefined,
    outputText: typeof raw.outputText === "string" ? raw.outputText : undefined,
    error:
      raw.error && typeof raw.error === "object" && typeof (raw.error as Record<string, unknown>).message === "string"
        ? {
            code:
              typeof (raw.error as Record<string, unknown>).code === "string"
                ? ((raw.error as Record<string, unknown>).code as string)
                : undefined,
            message: (raw.error as Record<string, unknown>).message as string,
          }
        : undefined,
    toolCalls,
  };
  const storedCost = raw.cost;
  record.cost =
    typeof storedCost === "number" && Number.isFinite(storedCost) ? storedCost : computeCost(record, record.model);
  return record;
}

function turnParams(record: TurnRecord) {
  return {
    id: record.id,
    session_id: record.sessionId,
    conversation_id: record.conversationId ?? null,
    workspace_id: record.workspaceId,
    workspace_name: record.workspaceName,
    origin: record.origin ?? null,
    timestamp: record.timestamp,
    user_input: record.userInput ?? null,
    model: record.model ?? null,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    reasoning_tokens: record.reasoningTokens,
    cached_input_tokens: record.cachedInputTokens,
    cache_creation_tokens: record.cacheCreationTokens,
    cost_usd: record.cost ?? null,
    reasoning_text: record.reasoningText ?? null,
    output_text: record.outputText ?? null,
    error_code: record.error?.code ?? null,
    error_message: record.error?.message ?? null,
  };
}

function insertRecord(conn: Database.Database, record: TurnRecord): boolean {
  const inserted = conn.prepare(INSERT_TURN_SQL).run(turnParams(record));
  if (inserted.changes === 0) return false;

  const insertTool = conn.prepare(INSERT_TOOL_SQL);
  record.toolCalls.forEach((tool, position) => {
    insertTool.run({
      turn_id: record.id,
      position,
      name: tool.name,
      args_json: JSON.stringify(tool.args),
      output: tool.output,
      status: isToolStatus(tool.status) ? tool.status : "ok",
    });
  });
  return true;
}

function importLegacyJsonl(conn: Database.Database): void {
  const imported = conn.prepare("SELECT value FROM usage_meta WHERE key = ?").get(LEGACY_IMPORT_KEY);
  if (imported || !existsSync(LEGACY_JSONL_FILE)) return;

  let contents: string;
  try {
    contents = readFileSync(LEGACY_JSONL_FILE, "utf8");
  } catch (err) {
    log.error(
      { event: "usage_legacy_import_read_failed", outcome: "import_deferred", err, filePath: LEGACY_JSONL_FILE },
      "failed to read legacy usage JSONL",
    );
    return;
  }

  const records: TurnRecord[] = [];
  let skipped = 0;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = normalizeLegacyRecord(JSON.parse(line));
      if (record) records.push(record);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  const migrate = conn.transaction(() => {
    let inserted = 0;
    for (const record of records) {
      if (insertRecord(conn, record)) inserted += 1;
    }
    conn.prepare("INSERT INTO usage_meta (key, value) VALUES (?, ?)").run(LEGACY_IMPORT_KEY, new Date().toISOString());
    return inserted;
  });
  const inserted = migrate();

  log.info(
    {
      event: "usage_legacy_jsonl_imported",
      outcome: "migration_complete",
      inserted,
      skipped,
      source: LEGACY_JSONL_FILE,
    },
    "imported legacy usage JSONL into SQLite; legacy file retained as a migration artifact",
  );
}

/**
 * Preserve and replace the short-lived JSONL-backed metrics projection.
 *
 * That implementation used the same database filename and table name, but SQLite was explicitly
 * rebuildable and the JSONL journal held the complete records. Recognize only its known column
 * signature. Corrupt or otherwise unknown schemas are left untouched and will fail visibly.
 */
function archiveLegacyProjectionIfPresent(): void {
  if (!existsSync(DB_FILE)) return;

  const legacy = new Database(DB_FILE);
  let shouldArchive = false;
  try {
    const columns = legacy.prepare("PRAGMA table_info(usage_turns)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    shouldArchive =
      columns.length > 0 && !names.has("user_input") && LEGACY_PROJECTION_COLUMNS.every((column) => names.has(column));
    if (!shouldArchive) return;

    const checkpoint = legacy.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
    if (checkpoint.some((result) => result.busy !== 0)) {
      throw new Error("Cannot upgrade the legacy usage projection while another process is using it.");
    }
  } finally {
    legacy.close();
  }

  if (!shouldArchive) return;
  let archive = `${DB_FILE}.legacy-projection`;
  if (existsSync(archive)) archive = `${archive}-${Date.now()}`;

  renameSync(DB_FILE, archive);
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${DB_FILE}${suffix}`;
    if (existsSync(source)) renameSync(source, `${archive}${suffix}`);
  }
  log.warn(
    {
      event: "usage_legacy_projection_archived",
      outcome: "new_sqlite_store_will_import_jsonl",
      source: DB_FILE,
      archive,
    },
    "archived the legacy usage metrics projection before creating the full SQLite store",
  );
}

function openDatabase(): Database.Database {
  mkdirSync(path.dirname(DB_FILE), { recursive: true });
  archiveLegacyProjectionIfPresent();
  const conn = new Database(DB_FILE);
  try {
    conn.pragma("journal_mode = WAL");
    // FULL favors committed-log durability over the small latency saving of NORMAL.
    conn.pragma("synchronous = FULL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
    conn.exec(CREATE_SCHEMA_SQL);
    conn.pragma("user_version = 1");
    importLegacyJsonl(conn);
    return conn;
  } catch (err) {
    conn.close();
    throw err;
  }
}

function db(): Database.Database {
  if (g._usageDb && g._usageDbFile === DB_FILE) return g._usageDb;
  if (g._usageDb?.open) g._usageDb.close();
  g._usageDb = openDatabase();
  g._usageDbFile = DB_FILE;
  return g._usageDb;
}

function invalidateDb(): void {
  if (g._usageDb?.open) g._usageDb.close();
  delete g._usageDb;
  delete g._usageDbFile;
}

function errorFromRow(row: { error_code: string | null; error_message: string | null }): RunErrorRecord | undefined {
  if (row.error_message === null) return undefined;
  return {
    code: row.error_code ?? undefined,
    message: row.error_message,
  };
}

function parseToolArgs(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToTurn(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    conversationId: row.conversation_id ?? undefined,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    origin: row.origin ? (row.origin as SessionOrigin) : undefined,
    timestamp: row.timestamp,
    userInput: row.user_input ?? undefined,
    model: row.model ?? undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cost: row.cost_usd ?? undefined,
    reasoningText: row.reasoning_text ?? undefined,
    outputText: row.output_text ?? undefined,
    error: errorFromRow(row),
    toolCalls: [],
  };
}

export function appendUsage(partial: Omit<TurnRecord, "id" | "timestamp" | "cost">): void {
  const record: TurnRecord = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...partial,
  };
  record.cost = computeCost(record, record.model);

  try {
    const conn = db();
    conn.transaction(() => insertRecord(conn, record))();
  } catch (err) {
    invalidateDb();
    log.error(
      { event: "usage_record_insert_failed", outcome: "usage_record_not_persisted", err, id: record.id },
      "failed to persist usage record",
    );
  }
}

export function recordTurnUsage(
  ctx: UsageContext,
  usage: TurnUsageFields & { type?: string },
  append: (record: Omit<TurnRecord, "id" | "timestamp" | "cost">) => void = appendUsage,
): void {
  const fields = { ...usage };
  delete fields.type;
  append({ ...ctx, ...fields });
}

/** Persist a terminal run error without pretending that an incomplete model turn consumed tokens. */
export function recordRunError(
  ctx: UsageContext,
  error: RunErrorRecord,
  userInput?: string,
  append: (record: Omit<TurnRecord, "id" | "timestamp" | "cost">) => void = appendUsage,
): void {
  append({
    ...ctx,
    userInput,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    toolCalls: [],
    error,
  });
}

// Dashboard list payload — newest first, bounded for response size only. No heavy content columns
// are selected, so large prompts and tool output do not affect normal dashboard reads.
export function listUsageLight(workspaceId?: string): LightTurnRecord[] {
  const where = workspaceId ? "WHERE workspace_id = ?" : "";
  const params = workspaceId ? [workspaceId, MAX_DASHBOARD_TURNS] : [MAX_DASHBOARD_TURNS];
  const rows = db()
    .prepare(
      `
        SELECT
          recent.*,
          tools.position AS tool_position,
          tools.name AS tool_name,
          tools.status AS tool_status
        FROM (
          SELECT
            id, session_id, conversation_id, workspace_id, workspace_name, origin, timestamp,
            model, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens,
            cache_creation_tokens, cost_usd, error_code, error_message
          FROM usage_turns
          ${where}
          ORDER BY timestamp DESC, id DESC
          LIMIT ?
        ) AS recent
        LEFT JOIN usage_tool_calls AS tools ON tools.turn_id = recent.id
        ORDER BY recent.timestamp DESC, recent.id DESC, tools.position ASC
      `,
    )
    .all(...params) as LightJoinedRow[];

  const result: LightTurnRecord[] = [];
  const byId = new Map<string, LightTurnRecord>();
  for (const row of rows) {
    let record = byId.get(row.id);
    if (!record) {
      record = {
        id: row.id,
        sessionId: row.session_id,
        conversationId: row.conversation_id ?? undefined,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        origin: row.origin ? (row.origin as SessionOrigin) : undefined,
        timestamp: row.timestamp,
        model: row.model ?? undefined,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
        cachedInputTokens: row.cached_input_tokens,
        cacheCreationTokens: row.cache_creation_tokens,
        cost: row.cost_usd ?? undefined,
        error: errorFromRow(row),
        toolCalls: [],
      };
      byId.set(row.id, record);
      result.push(record);
    }
    if (row.tool_name) {
      record.toolCalls.push({
        name: row.tool_name,
        status: isToolStatus(row.tool_status) ? row.tool_status : "ok",
      });
    }
  }
  return result;
}

// Full per-session detail, returned oldest first so tool executions render in run order.
export function getSessionDetail(sessionId: string): TurnRecord[] {
  const rows = db()
    .prepare(
      `
        SELECT
          turns.*,
          tools.position AS tool_position,
          tools.name AS tool_name,
          tools.args_json AS tool_args_json,
          tools.output AS tool_output,
          tools.status AS tool_status
        FROM usage_turns AS turns
        LEFT JOIN usage_tool_calls AS tools ON tools.turn_id = turns.id
        WHERE turns.session_id = ?
        ORDER BY turns.timestamp ASC, turns.id ASC, tools.position ASC
      `,
    )
    .all(sessionId) as JoinedTurnRow[];

  const result: TurnRecord[] = [];
  const byId = new Map<string, TurnRecord>();
  for (const row of rows) {
    let record = byId.get(row.id);
    if (!record) {
      record = rowToTurn(row);
      byId.set(row.id, record);
      result.push(record);
    }
    if (row.tool_name) {
      record.toolCalls.push({
        name: row.tool_name,
        args: parseToolArgs(row.tool_args_json),
        output: row.tool_output ?? "",
        status: isToolStatus(row.tool_status) ? row.tool_status : "ok",
      });
    }
  }
  return result;
}

/**
 * Create a consistent snapshot of the live database.
 *
 * The caller must place `destination` on separately backed-up or remote storage for this to be a
 * real backup; another file in WORKSPACES_ROOT does not protect against volume or host loss.
 */
export async function backupUsage(destination: string): Promise<void> {
  if (!destination.trim()) throw new Error("A usage backup destination is required.");
  const resolved = path.resolve(destination);
  if (resolved === path.resolve(DB_FILE)) throw new Error("The usage backup must not overwrite the live database.");
  mkdirSync(path.dirname(resolved), { recursive: true });
  await db().backup(resolved);
}

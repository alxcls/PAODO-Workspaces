import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateDatabase } from "./index";
import { baselineSchema } from "./001-baseline";
import { toolCallIds } from "./002-tool-call-ids";

function databaseWithTurns(toolCalls: unknown[][]) {
  const conn = new Database(":memory:");
  migrateDatabase(conn, [baselineSchema]);
  conn
    .prepare(
      "INSERT INTO sessions (id, workspace_id, workspace_name, origin, started_at, status) VALUES ('s1', 'w1', 'WS', 'chat', '2026-10-03T10:00:00.000Z', 'success')",
    )
    .run();
  const insert = conn.prepare(
    "INSERT INTO turns (id, session_id, timestamp, tool_calls_json) VALUES (?, 's1', '2026-10-03T10:01:00.000Z', ?)",
  );
  toolCalls.forEach((calls, index) => insert.run(`t${index}`, JSON.stringify(calls)));
  return conn;
}

function storedCalls(conn: Database.Database): Array<Array<Record<string, unknown>>> {
  const rows = conn.prepare("SELECT tool_calls_json FROM turns ORDER BY seq").all() as Array<{
    tool_calls_json: string;
  }>;
  return rows.map((row) => JSON.parse(row.tool_calls_json));
}

describe("tool-call-ids migration", () => {
  it("gives each stored call a distinct id and leaves the rest of it as it was", () => {
    const call = { name: "file_read", args: { path: "a.ts" }, output: "body", status: "ok" };
    const conn = databaseWithTurns([[call, call], [], [{ ...call, name: "exec_command" }]]);

    migrateDatabase(conn, [baselineSchema, toolCallIds]);

    const [first, empty, third] = storedCalls(conn);
    expect(first).toEqual([
      { id: expect.any(String), ...call },
      { id: expect.any(String), ...call },
    ]);
    expect(empty).toEqual([]);
    expect(third[0]).toMatchObject({ name: "exec_command" });
    const ids = [...first, ...third].map((stored) => stored.id);
    expect(new Set(ids).size).toBe(3);
    expect(conn.pragma("user_version", { simple: true })).toBe(2);
  });

  it("keeps an id a call already has", () => {
    const conn = databaseWithTurns([[{ id: "kept", name: "file_read", args: {}, output: "", status: "ok" }]]);

    migrateDatabase(conn, [baselineSchema, toolCallIds]);

    expect(storedCalls(conn)[0][0].id).toBe("kept");
  });
});

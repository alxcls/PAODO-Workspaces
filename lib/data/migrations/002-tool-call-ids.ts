import type { Migration } from "./index";

/**
 * Gives every stored tool call an id. Calls live as a JSON list on their turn and were written
 * without one, so they could only be told apart by position; new turns get the id at write time.
 * Content only: no table or column changes. A call that already has an id keeps it.
 */
export const toolCallIds: Migration = {
  version: 2,
  name: "tool-call-ids",
  up(db) {
    const turns = db
      .prepare("SELECT seq, tool_calls_json FROM turns WHERE json_array_length(tool_calls_json) > 0")
      .all() as Array<{ seq: number; tool_calls_json: string }>;
    const update = db.prepare("UPDATE turns SET tool_calls_json = ? WHERE seq = ?");

    for (const turn of turns) {
      const calls: unknown = JSON.parse(turn.tool_calls_json);
      if (!Array.isArray(calls)) continue;
      let changed = false;
      const withIds = calls.map((call: unknown) => {
        if (!call || typeof call !== "object" || Array.isArray(call)) return call;
        if (typeof (call as { id?: unknown }).id === "string") return call;
        changed = true;
        return { id: crypto.randomUUID(), ...call };
      });
      if (changed) update.run(JSON.stringify(withIds), turn.seq);
    }
  },
};

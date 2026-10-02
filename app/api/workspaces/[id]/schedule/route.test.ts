import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleEntry } from "@/lib/schedules/types";

const h = vi.hoisted(() => ({ entry: null as ScheduleEntry | null }));
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({ getWorkspace: () => ({ id: "11111111-1111-4111-8111-111111111111" }) }),
}));
vi.mock("@/lib/infra/schedules/scheduleStore", () => ({
  getSchedule: () => h.entry,
  setSchedule: (entry: ScheduleEntry) => {
    h.entry = entry;
  },
}));
import { PATCH, PUT } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const ctx = () => ({ params: Promise.resolve({ id }) });
const request = (body: unknown, method = "PATCH") =>
  new Request(`http://localhost/api/workspaces/${id}/schedule`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
const config = {
  prompt: "original",
  intervalValue: 1,
  intervalUnit: "day",
  startAt: "2026-01-01T09:00",
  timezone: "UTC",
  enabled: false,
};
beforeEach(() => {
  h.entry = null;
});

describe("schedule HTTP updates", () => {
  it("preserves concurrent edits to distinct fields", async () => {
    expect((await PUT(request(config, "PUT"), ctx())).status).toBe(200);
    const results = await Promise.all([
      PATCH(request({ prompt: "UI edit" }), ctx()),
      PATCH(request({ intervalValue: 5 }), ctx()),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(h.entry).toMatchObject({ prompt: "UI edit", intervalValue: 5 });
  });

  it.each([false, true])("refuses the freeze input with enabled=%s without changing state", async (enabled) => {
    await PUT(request(config, "PUT"), ctx());
    const before = h.entry;
    const response = await PATCH(request({ intervalValue: 1e300, enabled }), ctx());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "SCHEDULE_INVALID" });
    expect(h.entry).toBe(before);
  });
});

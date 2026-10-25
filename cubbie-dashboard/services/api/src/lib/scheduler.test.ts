import { test } from "node:test";
import assert from "node:assert/strict";
import type { Task } from "@cubbie/shared";
import { reminderTime } from "./scheduler";

const base = (over: Partial<Task>): Task => ({ id: "x", view: "student", status: "todo", title: "t", kind: "assignment", source: "manual", createdAt: "", updatedAt: "", ...over });
const now = Date.parse("2026-10-24T12:00:00Z");

test("reminds 24 h before a far deadline", () => {
  assert.equal(reminderTime(base({ dueAt: "2026-10-27T06:59:00Z" }), now)?.toISOString(), "2026-10-26T06:59:00.000Z");
});
test("falls back to 2 h before when the deadline is within a day", () => {
  assert.equal(reminderTime(base({ dueAt: "2026-10-24T20:00:00Z" }), now)?.toISOString(), "2026-10-24T18:00:00.000Z");
});
test("no reminder for done cards or missing dates", () => {
  assert.equal(reminderTime(base({ dueAt: "2026-10-27T06:59:00Z", status: "done" }), now), null);
  assert.equal(reminderTime(base({ dueAt: null }), now), null);
});
test("job follow-ups use followUpAt", () => {
  const t = base({ view: "jobs", status: "applied", kind: "follow_up", job: { company: "A", role: "B", stage: "applied", followUpAt: "2026-10-26T17:00:00Z" } });
  assert.equal(reminderTime(t, now)?.toISOString(), "2026-10-25T17:00:00.000Z");
});

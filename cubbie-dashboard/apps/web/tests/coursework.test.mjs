import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the real TypeScript selectors and components without a browser.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const cache = new Map();
function load(path) {
  const file = [path, `${path}.ts`, `${path}.tsx`].find(existsSync);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const output = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const sourceRequire = id => id.startsWith(".") ? load(resolve(dirname(file), id))
    : id.startsWith("@cubbie/shared/") ? load(resolve(root, "../../packages/shared/src", id.slice("@cubbie/shared/".length))) : require(id);
  new Function("require", "module", "exports", output)(sourceRequire, module, module.exports);
  return module.exports;
}
const { dashboardTasks, datedItems, isCourseworkTodo } = load(resolve(root, "src/lib/derive"));
const task = (id, patch = {}) => ({ id, view: "student", status: "todo", title: `Assignment ${id}`,
  kind: "assignment", source: "canvas", dueAt: "2026-10-25T12:00:00-07:00", ...patch });
const now = new Date("2026-10-24T15:00:00-07:00");

test("legacy imports without publication metadata are visible; explicit unpublished work is hidden", () => {
  assert.equal(isCourseworkTodo(task("legacy"), now), true);
  assert.deepEqual(dashboardTasks([task("legacy"), task("published", { published: true }),
    task("unpublished", { published: false }), task("unknown", { published: false, status: "in_progress" })], now).map(t => t.id),
    ["legacy", "published"]);
});

test("Todo includes today and day 15, excludes past, day 16, undated and invalid dates", () => {
  for (const dueAt of ["2026-10-24T00:00:00-07:00", "2026-11-08T23:59:59-07:00"])
    assert.equal(isCourseworkTodo(task("in", { dueAt }), now), true);
  for (const dueAt of ["2026-10-23T23:59:59-07:00", "2026-11-09T00:00:00-07:00", null, "invalid"])
    assert.equal(isCourseworkTodo(task("out", { dueAt }), now), false);
});

test("shared selection preserves in-progress, partial and submitted work with identical list IDs", () => {
  const selected = dashboardTasks([task("todo"), task("far", { dueAt: "2026-12-01T00:00:00-07:00" }),
    task("partial", { status: "partial", dueAt: null }), task("submitted", { status: "done" }),
    task("grading", { view: "grader", dueAt: null }), task("job", { view: "jobs" })], now);
  assert.deepEqual(selected.map(t => t.id), ["todo", "partial", "submitted", "grading", "job"]);
  assert.equal(selected.find(t => t.id === "partial").status, "in_progress");
  assert.deepEqual(datedItems(selected.filter(t => t.view === "student")).map(i => i.task.id).sort(),
    ["partial", "submitted", "todo"]);
});

test("List hides overdue work and Calendar shows only the next seven calendar days", () => {
  const at = days => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(23, 59, 59, 999); return d.toISOString(); };
  const selected = dashboardTasks([task("day6", { dueAt: at(6) }),
    task("day7", { dueAt: at(7) }), task("day15", { dueAt: at(15) }),
    task("submitted", { status: "done", dueAt: at(2) }),
    task("overdue", { status: "in_progress", dueAt: at(-1) }),
    task("earlierToday", { status: "in_progress", dueAt: new Date(Date.now() - 1000).toISOString() }),
    task("undated", { status: "in_progress", dueAt: null })]);
  const { Board } = load(resolve(root, "src/components/Board"));
  const { Upcoming } = load(resolve(root, "src/components/Upcoming"));
  const { WeekView } = load(resolve(root, "src/components/WeekView"));
  const render = Component => renderToStaticMarkup(React.createElement(Component, {
    tasks: selected, view: "student", onOpen() {}, onMove() {}, onCreate() {}, showView: false
  }));
  const board = render(Board);
  for (const t of selected) assert.ok(board.includes(t.title));
  const list = render(Upcoming);
  for (const id of ["day6", "day7", "day15", "submitted", "undated"]) assert.ok(list.includes(`Assignment ${id}`));
  for (const id of ["overdue", "earlierToday"]) assert.ok(!list.includes(`Assignment ${id}`));
  const calendar = render(WeekView);
  assert.equal((calendar.match(/class="day(?: today)?\s*"/g) ?? []).length, 7);
  for (const id of ["day6", "submitted"]) assert.ok(calendar.includes(`Assignment ${id}`));
  for (const id of ["day7", "day15", "overdue", "undated"]) assert.ok(!calendar.includes(`Assignment ${id}`));
  assert.ok(!calendar.includes("Other dates"));
});

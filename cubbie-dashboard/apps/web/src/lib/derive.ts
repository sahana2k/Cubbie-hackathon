import type { Task, View } from "@cubbie/shared/types";
import { VIEWS } from "@cubbie/shared/views";
import { dayDiff } from "./dates";

export const isOpen = (t: Task) => !VIEWS[t.view].doneStatuses.includes(t.status);

export interface DatedItem { key: string; task: Task; at: string | null; label: string }

/** Every date a student should see for a task: its due date plus job follow-ups, assessment deadlines and students' deadlines. */
export function datedItems(tasks: Task[]): DatedItem[] {
  const out: DatedItem[] = [];
  for (const t of tasks) {
    if (t.view !== "student" && !isOpen(t)) continue;
    const primary = t.view === "jobs" ? (t.job?.nextAction ?? t.title) : t.title;
    out.push({ key: `${t.id}:due`, task: t, at: t.dueAt ?? null, label: primary });
    if (t.job?.followUpAt && t.job.followUpAt !== t.dueAt) out.push({ key: `${t.id}:fu`, task: t, at: t.job.followUpAt, label: "Follow up" });
    if (t.job?.assessmentDeadline && t.job.assessmentDeadline !== t.dueAt) out.push({ key: `${t.id}:oa`, task: t, at: t.job.assessmentDeadline, label: "Assessment due" });
    if (t.view === "grader" && !t.dueAt && t.grading?.studentDueAt && Date.parse(t.grading.studentDueAt) > Date.now())
      out.push({ key: `${t.id}:stu`, task: t, at: t.grading.studentDueAt, label: "Student submissions due" });
  }
  return out.sort((a, b) => (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity));
}

export function matches(t: Task, q: string) {
  if (!q) return true;
  const hay = [t.title, t.course, t.notes, t.job?.company, t.job?.role, t.job?.nextAction].filter(Boolean).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w));
}

/** One plain sentence that summarizes the current view. */
export function summary(view: View, tasks: Task[], now = new Date()): string {
  const open = tasks.filter(t => t.view === view && isOpen(t));
  const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  if (view === "grader") {
    const waiting = open.reduce((s, t) => s + (t.grading?.needsGrading ?? 0), 0);
    const items = open.filter(t => (t.grading?.needsGrading ?? 0) > 0).length;
    const unknown = open.filter(t => t.kind === "grading" && t.grading && t.grading.needsGrading == null).length;
    const dated = open.filter(t => t.grading?.gradingDueAt && dayDiff(new Date(t.grading.gradingDueAt), now) <= 7).length;
    return `${plural(waiting, "submission")} to grade across ${plural(items, "assignment")}` +
      (dated ? `, ${dated} with a grading deadline this week` : "") + (unknown ? `. ${unknown} count unavailable.` : ".");
  }
  if (view === "jobs") {
    const oa = open.filter(t => t.job?.stage === "assessment").length;
    const overdueFu = open.filter(t => t.job?.followUpAt && Date.parse(t.job.followUpAt) < now.getTime()).length;
    const offers = open.filter(t => t.status === "offer").length;
    const active = open.filter(t => t.status !== "offer").length;
    return `${plural(active, "active application")}, ${plural(oa, "assessment")} open, ${plural(overdueFu, "follow-up")} overdue` + (offers ? `, ${plural(offers, "offer")} to decide.` : ".");
  }
  const overdue = open.filter(t => t.dueAt && Date.parse(t.dueAt) < now.getTime()).length;
  const today = open.filter(t => t.dueAt && Date.parse(t.dueAt) >= now.getTime() && dayDiff(new Date(t.dueAt), now) === 0).length;
  const week = open.filter(t => t.dueAt && Date.parse(t.dueAt) >= now.getTime() && dayDiff(new Date(t.dueAt), now) < 7).length;
  return `${plural(today, "thing")} due today, ${overdue} overdue, ${week} due in the next 7 days.`;
}

/** Todo includes published coursework due today through the end of day 15. */
export function isCourseworkTodo(task: Task, now = new Date()): boolean {
  // Older imports predate publication metadata. Keep those visible until a
  // fresh Canvas sync can supply it; explicit unpublished records stay hidden.
  if (task.published === false || !task.dueAt) return false;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 16);
  const due = Date.parse(task.dueAt);
  return due >= start.getTime() && due < end.getTime();
}

/** One coursework selection shared by Board, List, Calendar, and the summary. */
export function dashboardTasks(tasks: Task[], now = new Date()): Task[] {
  return tasks.filter(task => task.view !== "student" || (
    task.published !== false &&
    (task.status !== "todo" || isCourseworkTodo(task, now))
  )).map(task => task.view === "student" && task.status === "partial"
    ? { ...task, status: "in_progress" } : task);
}

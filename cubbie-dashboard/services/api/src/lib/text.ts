import type { Task } from "@cubbie/shared";
import { VIEWS } from "@cubbie/shared";

const fmt = (iso: string, tz?: string) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
export const isOpen = (t: Task) => !VIEWS[t.view].doneStatuses.includes(t.status);
const byDue = (a: Task, b: Task) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);

/** Plain-text lines for Discord and reminders. Same rules as the board: unavailable is never zero. */
export function dueList(tasks: Task[], tz?: string, max = 6) {
  const open = tasks.filter(t => t.view === "student" && isOpen(t) && t.dueAt).sort(byDue).slice(0, max);
  return open.length ? open.map(t => `- ${t.course ? t.course + " " : ""}${t.title}: ${fmt(t.dueAt!, tz)}`).join("\n") : "Nothing due. Nice.";
}
export function gradingList(tasks: Task[], tz?: string, max = 6) {
  const open = tasks.filter(t => t.view === "grader" && isOpen(t)).slice(0, max);
  if (!open.length) return "Nothing waiting to be graded.";
  return open.map(t => {
    const g = t.grading ?? {};
    const need = g.needsGrading == null ? "needs grading: unavailable" : `${g.needsGrading} to grade`;
    const due = g.gradingDueAt ? `grading due ${fmt(g.gradingDueAt, tz)}` : "grading deadline not specified";
    return `- ${t.course ?? ""} ${t.title}: ${need}, ${due}`.trim();
  }).join("\n");
}
export function appsList(tasks: Task[], tz?: string, max = 6) {
  const open = tasks.filter(t => t.view === "jobs" && isOpen(t) && t.job).sort(byDue).slice(0, max);
  if (!open.length) return "No open applications.";
  return open.map(t => `- ${t.job!.company}, ${t.job!.role}: ${t.job!.nextAction ?? t.title}${t.dueAt ? ` (${fmt(t.dueAt, tz)})` : ""}`).join("\n");
}
export function reminderText(t: Task, tz?: string) {
  const due = t.dueAt ?? t.job?.followUpAt ?? t.job?.assessmentDeadline;
  const what = t.job ? `${t.job.company}, ${t.job.role}: ${t.job.nextAction ?? t.title}` : `${t.course ? t.course + " " : ""}${t.title}`;
  return `Reminder: ${what}${due ? `, due ${fmt(due, tz)}` : ""}.`;
}

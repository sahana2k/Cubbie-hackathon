import type { Task } from "@cubbie/shared/types";
import { VIEWS } from "@cubbie/shared/views";
import { addDays, dueInfo, fmtDay, fmtTime } from "../lib/dates";

/**
 * Demo-mode stand-in for Cubbie. In live mode the text goes to the real Cubbie over iMessage
 * through the relay, and Cubbie's reply comes back the same way. Replies follow Cubbie's
 * iMessage style: short, plain text, one idea per message.
 */
export interface BrainResult { replies: string[]; create?: Omit<Task, "id" | "createdAt" | "updatedAt"> }

const open = (t: Task) => !VIEWS[t.view].doneStatuses.includes(t.status);
const byDue = (a: Task, b: Task) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function cubbieReply(input: string, tasks: Task[], now = new Date()): BrainResult {
  const text = input.trim().toLowerCase();

  const add = text.match(/^(?:add|track)\s+(.+?)(?:\s+due\s+(today|tonight|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday))?$/);
  if (add) {
    const title = add[1].replace(/^./, c => c.toUpperCase());
    let due: Date | null = null;
    const when = add[2];
    if (when) {
      due = new Date(now); due.setHours(23, 59, 0, 0);
      if (when === "tomorrow") due = addDays(due, 1);
      else if (DAYS.includes(when)) { let diff = (DAYS.indexOf(when) - now.getDay() + 7) % 7; if (diff === 0) diff = 7; due = addDays(due, diff); }
    }
    return {
      replies: [`Added "${title}" to your board${due ? `, due ${fmtDay(due)} ${fmtTime(due)}` : ""}.`, "Want a reminder the night before?"],
      create: { view: "student", status: "todo", kind: "task", title, dueAt: due ? due.toISOString() : null, dueLabel: due ? null : "No due date", source: "cubbie", progress: 0, priority: "medium" }
    };
  }

  if (/grad|ta\b|205|speedgrader/.test(text)) {
    const items = tasks.filter(t => t.view === "grader" && open(t) && t.grading).sort((a, b) => (b.grading?.needsGrading ?? -1) - (a.grading?.needsGrading ?? -1)).slice(0, 2);
    if (!items.length) return { replies: ["Nothing waiting to be graded right now. Nice."] };
    return {
      replies: items.map(t => {
        const g = t.grading!;
        const lines = [`${t.course} — ${t.title}`];
        lines.push(g.needsGrading == null ? "Needs grading: Unavailable" : `To Do: Grade ${g.needsGrading} submissions`);
        if (g.studentDueAt) lines.push(`Student submissions due: ${fmtDay(new Date(g.studentDueAt))}, ${fmtTime(new Date(g.studentDueAt))}`);
        lines.push(g.gradingDueAt ? `Grading due: ${fmtDay(new Date(g.gradingDueAt))}, ${fmtTime(new Date(g.gradingDueAt))}` : "Grading deadline: Not specified");
        return lines.join("\n");
      })
    };
  }

  if (/job|app|follow|assess|interview|offer|recruit|cubbridge/.test(text)) {
    const items = tasks.filter(t => t.view === "jobs" && open(t) && t.job).sort(byDue).slice(0, 3);
    if (!items.length) return { replies: ["No open applications on your board."] };
    return {
      replies: [
        "Top career actions:\n" + items.map(t => `- ${t.job!.company}: ${t.job!.nextAction ?? t.title} (${dueInfo(t.dueAt, now, t.dueLabel).label.toLowerCase()})`).join("\n"),
        "Your tracker workbook has the drafts and contacts. Want me to open the Harbor Robotics follow-up?"
      ]
    };
  }

  if (/due|deadline|today|tonight|week|chaos|busy|what.*(do|left)/.test(text)) {
    const items = tasks.filter(t => t.view === "student" && open(t) && t.dueAt).sort(byDue).slice(0, 3);
    if (!items.length) return { replies: ["Nothing due. Go touch grass 🌵"] };
    return { replies: ["Due soonest:\n" + items.map(t => `- ${t.course ?? ""} ${t.title}, ${dueInfo(t.dueAt, now).label.toLowerCase()}`.trim()).join("\n")] };
  }

  if (/remind|check.?in|nudge/.test(text)) return { replies: ["Okay. I'll text you then.", "You can see it on your Google Calendar too."] };
  if (/^(hi|hey|hello|yo|sup)\b/.test(text)) return { replies: ["hey 💙 what's up?"] };
  if (/thank/.test(text)) return { replies: ["anytime 💙"] };

  return {
    replies: [
      "This is demo mode, so I'm answering from the board. Try:",
      "what's due this week\nwhat needs grading\nmy applications\nadd lab report due friday"
    ]
  };
}

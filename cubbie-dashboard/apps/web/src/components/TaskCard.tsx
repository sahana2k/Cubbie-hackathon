import type { Task } from "@cubbie/shared/types";
import { VIEWS } from "@cubbie/shared/views";
import { dueInfo, fmtDay } from "../lib/dates";

const KIND_LABEL: Record<Task["kind"], string> = {
  assignment: "Assignment", quiz: "Quiz", exam: "Exam", discussion: "Discussion", project: "Project", reading: "Reading",
  grading: "Grading", application: "Application", assessment: "Assessment", interview: "Interview", follow_up: "Follow-up", task: "Task"
};

const count = (n: number | null | undefined) => (n == null ? "Unavailable" : String(n));

export function TaskCard({ task, onOpen }: { task: Task; onOpen: (id: string) => void }) {
  const done = VIEWS[task.view].doneStatuses.includes(task.status);
  const due = done
    ? { label: task.view === "jobs" ? (task.status === "offer" ? dueInfo(task.dueAt, new Date(), task.dueLabel).label : "Closed") : task.dueAt ? `Was due ${fmtDay(new Date(task.dueAt))}` : task.dueLabel ?? "Done", tone: task.status === "offer" ? dueInfo(task.dueAt).tone : ("none" as const) }
    : dueInfo(task.dueAt, new Date(), task.dueLabel);
  const g = task.grading;
  const j = task.job;
  return (
    <article
      className={`card prio-${task.priority ?? "none"}`}
      draggable
      onDragStart={e => { e.dataTransfer.setData("text/plain", task.id); e.dataTransfer.effectAllowed = "move"; (e.currentTarget as HTMLElement).classList.add("dragging"); }}
      onDragEnd={e => (e.currentTarget as HTMLElement).classList.remove("dragging")}
    >
      <button className="card-hit" onClick={() => onOpen(task.id)} aria-label={`Open ${task.title}`} />
      <div className="card-top">
        <span className="tag">{j ? j.company : task.course ?? "Personal"}</span>
        <span className="kind">{KIND_LABEL[task.kind]}</span>
      </div>
      <h3>{task.title}</h3>
      {j && <p className="sub">{j.role}{j.location ? `, ${j.location}` : ""}</p>}

      {g && (
        <dl className="stats">
          <div><dt>Submitted</dt><dd>{g.studentsSubmitted == null ? "Unavailable" : g.eligibleStudents != null ? `${g.studentsSubmitted} of ${g.eligibleStudents}` : g.studentsSubmitted}</dd></div>
          <div><dt>To grade</dt><dd>{count(g.needsGrading)}</dd></div>
        </dl>
      )}
      {j?.nextAction && <p className="next">Next: {j.nextAction}</p>}

      {typeof task.progress === "number" && task.progress > 0 && task.progress < 100 && (
        <div className="progress" role="progressbar" aria-valuenow={task.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
          <span style={{ width: `${task.progress}%` }} />
        </div>
      )}

      <div className="card-foot">
        <span className={`due tone-${due.tone}`}>{due.label}</span>
        <span className="foot-right">
          {j?.calendarState === "created" && <span className="mini ok" title="Reminder on Google Calendar">On calendar</span>}
          {j?.calendarState === "pending_approval" && <span className="mini" title="Waiting for your approval in iMessage">Needs your OK</span>}
          {typeof task.points === "number" && <span className="mini">{task.points} pts</span>}
          {task.source === "cubbie" && <span className="mini">From Cubbie</span>}
        </span>
      </div>
    </article>
  );
}

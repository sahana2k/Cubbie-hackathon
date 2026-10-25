import { useEffect, useState } from "react";
import type { Task } from "@cubbie/shared/types";
import { VIEWS } from "@cubbie/shared/views";
import { dueInfo, fmtDay, fmtTime, fromLocalInput, localZone, toLocalInput } from "../lib/dates";

interface Props {
  task: Task;
  onClose: () => void;
  onSave: (id: string, patch: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onAsk: (prompt: string) => void;
}

const when = (iso?: string | null) => (iso ? `${fmtDay(new Date(iso))}, ${fmtTime(new Date(iso))}` : null);
const n = (v: number | null | undefined) => (v == null ? "Unavailable" : String(v));

export function askPrompt(t: Task) {
  if (t.view === "jobs" && t.job) {
    if (t.job.stage === "assessment" && !t.job.assessmentDeadline) return `cubbie can you confirm the deadline for my ${t.job.company} ${t.job.role} assessment?`;
    return `cubbie draft a follow-up for my ${t.job.company} ${t.job.role} application`;
  }
  if (t.view === "grader") return `what needs grading for ${t.course ?? ""} ${t.title}`.replace(/\s+/g, " ");
  return `cubbie help me plan ${t.title}${t.course ? ` for ${t.course}` : ""}, it's due ${dueInfo(t.dueAt, new Date(), t.dueLabel).label.toLowerCase()}`;
}

export function TaskDrawer({ task, onClose, onSave, onDelete, onAsk }: Props) {
  const [d, setD] = useState<Task>(task);
  useEffect(() => setD(task), [task]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const def = VIEWS[task.view];
  const set = <K extends keyof Task>(k: K, v: Task[K]) => setD(x => ({ ...x, [k]: v }));
  const setJob = (patch: Partial<NonNullable<Task["job"]>>) => setD(x => ({ ...x, job: { ...x.job!, ...patch } }));
  const dirty = JSON.stringify(d) !== JSON.stringify(task);
  const g = task.grading;
  const j = d.job;

  return (
    <div className="drawer-wrap" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <header className="drawer-head">
          <span className="tag">{j ? j.company : task.course ?? "Personal"}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <label className="field big">
          <span className="sr">Title</span>
          <input id="drawer-title" value={d.title} onChange={e => set("title", e.target.value)} />
        </label>

        <div className="field-grid">
          <label className="field"><span>Status</span>
            <select value={d.status} onChange={e => set("status", e.target.value)}>
              {def.columns.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          {!j && (
            <label className="field"><span>Course</span><input value={d.course ?? ""} onChange={e => set("course", e.target.value || null)} /></label>
          )}
          <label className="field"><span>{task.view === "grader" ? "Grading due" : "Due"}</span>
            <input type="datetime-local" value={toLocalInput(d.dueAt)} onChange={e => set("dueAt", fromLocalInput(e.target.value))} />
          </label>
          <label className="field"><span>Priority</span>
            <select value={d.priority ?? "medium"} onChange={e => set("priority", e.target.value as Task["priority"])}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
          </label>
        </div>
        <p className="zone-note">Times are shown in {localZone}.{!d.dueAt && task.dueLabel ? ` Currently: ${task.dueLabel}.` : ""}</p>

        {task.view !== "jobs" && (
          <label className="field"><span>Progress: {d.progress ?? 0}%</span>
            <input type="range" min={0} max={100} step={5} value={d.progress ?? 0} onChange={e => set("progress", Number(e.target.value))} />
          </label>
        )}

        {g && (
          <section className="facts">
            <h4>From Canvas</h4>
            <dl>
              <dt>Section</dt><dd>{g.section ?? "Not specified"}</dd>
              <dt>Students submitted</dt><dd>{g.studentsSubmitted == null ? "Unavailable with this connection" : g.eligibleStudents != null ? `${g.studentsSubmitted} of ${g.eligibleStudents}` : g.studentsSubmitted}</dd>
              <dt>Needs grading</dt><dd>{n(g.needsGrading)}</dd>
              <dt>Student submissions due</dt><dd>{when(g.studentDueAt) ?? "Deadline unavailable"}</dd>
              <dt>Grading due</dt><dd>{when(g.gradingDueAt) ?? "Not specified"}</dd>
            </dl>
            <p className="fine">Counts are read-only. Grades are never changed from this board.</p>
          </section>
        )}

        {j && (
          <section className="facts">
            <h4>Application</h4>
            <div className="field-grid">
              <label className="field"><span>Company</span><input value={j.company} onChange={e => setJob({ company: e.target.value })} /></label>
              <label className="field"><span>Role</span><input value={j.role} onChange={e => setJob({ role: e.target.value })} /></label>
              <label className="field"><span>Follow up</span><input type="datetime-local" value={toLocalInput(j.followUpAt)} onChange={e => setJob({ followUpAt: fromLocalInput(e.target.value) })} /></label>
              <label className="field"><span>Next action</span><input value={j.nextAction ?? ""} onChange={e => setJob({ nextAction: e.target.value || null })} /></label>
            </div>
            <dl>
              <dt>Applied on</dt><dd>{j.applicationDate ? `${j.applicationDate} (${j.applicationDateEvidence})` : j.confirmationAt ? `Not evidenced. Confirmation received ${when(j.confirmationAt)}` : "Unknown"}</dd>
              {(j.assessmentDeadline || j.assessmentDeadlineText) && <><dt>Assessment</dt><dd>{when(j.assessmentDeadline) ?? `Needs confirming: \u201c${j.assessmentDeadlineText}\u201d`}</dd></>}
              <dt>Calendar reminder</dt><dd>{({ none: "None", pending_approval: "Waiting for your OK in iMessage", created: "On Google Calendar", event_only: "Event created, reminders not verified", failed: "Creation failed" } as const)[j.calendarState ?? "none"]}</dd>
              <dt>Verified contacts</dt><dd>{j.verifiedContacts == null ? "Research incomplete" : j.verifiedContacts}</dd>
            </dl>
          </section>
        )}

        <label className="field"><span>Notes</span><textarea rows={3} value={d.notes ?? ""} onChange={e => set("notes", e.target.value || null)} /></label>

        {task.url && <a className="ext" href={task.url} target="_blank" rel="noreferrer">Open in {task.source === "canvas" ? "Canvas" : "source"}</a>}
        <p className="fine">Source: {task.source}{task.sourceId ? ` (${task.sourceId})` : ""}. Updated {when(task.updatedAt)}.</p>

        <footer className="drawer-foot">
          <button className="danger" onClick={() => { if (confirm("Delete this card from your board?")) onDelete(task.id); }}>Delete</button>
          <span className="grow" />
          <button className="ghost" onClick={() => onAsk(askPrompt(d))}>Ask Cubbie</button>
          <button className="primary" disabled={!dirty} onClick={() => onSave(task.id, d)}>Save changes</button>
        </footer>
      </aside>
    </div>
  );
}

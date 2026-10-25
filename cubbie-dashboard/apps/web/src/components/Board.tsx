import { useState } from "react";
import type { Task, View } from "@cubbie/shared/types";
import { VIEWS } from "@cubbie/shared/views";
import type { TaskDraft } from "../api";
import { fromLocalInput } from "../lib/dates";
import { TaskCard } from "./TaskCard";

interface Props {
  view: View;
  tasks: Task[];
  onMove: (id: string, status: string) => void;
  onOpen: (id: string) => void;
  onCreate: (d: TaskDraft) => void;
}

const sortTasks = (a: Task, b: Task) => (a.dueAt ? Date.parse(a.dueAt) : Infinity) - (b.dueAt ? Date.parse(b.dueAt) : Infinity);

export function Board({ view, tasks, onMove, onOpen, onCreate }: Props) {
  const def = VIEWS[view];
  const [over, setOver] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  return (
    <div className="board" style={{ ["--cols" as string]: def.columns.length }}>
      {def.columns.map(col => {
        const items = tasks.filter(t => t.status === col.id).sort(sortTasks);
        return (
          <section
            key={col.id}
            className={`col wash-${col.wash} ${over === col.id ? "over" : ""}`}
            aria-label={col.label}
            onDragOver={e => { if (view !== "jobs") { e.preventDefault(); setOver(col.id); } }}
            onDragLeave={() => setOver(o => (o === col.id ? null : o))}
            onDrop={e => { e.preventDefault(); if (view === "jobs") return; setOver(null); const id = e.dataTransfer.getData("text/plain"); if (id) onMove(id, col.id); }}
          >
            <header className="col-head">
              <div>
                <h2>{col.label}<span className="n">{items.length}</span></h2>
                <p>{col.hint}</p>
              </div>
              {view !== "jobs" && <button className="add" onClick={() => setAdding(a => (a === col.id ? null : col.id))} aria-label={`Add to ${col.label}`} aria-expanded={adding === col.id}>+</button>}
            </header>
            {view !== "jobs" && adding === col.id && (
              <QuickAdd view={view} onCancel={() => setAdding(null)} onAdd={d => { onCreate({ ...d, status: col.id }); setAdding(null); }} />
            )}
            <div className="col-body">
              {items.map(t => <TaskCard key={t.id} task={t} onOpen={onOpen} />)}
              {items.length === 0 && adding !== col.id && <p className="empty">{view === "jobs" ? "Cards appear after Cubbie confirms an application’s status. Use Sync Job hunt to check Gmail." : view === "student" && col.id === "todo" ? "No published coursework due within 15 days." : "Drag a card here, or add one with +"}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function QuickAdd({ view, onAdd, onCancel }: { view: View; onAdd: (d: Omit<TaskDraft, "status">) => void; onCancel: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [due, setDue] = useState("");
  const jobs = view === "jobs";
  const submit = () => {
    if (!a.trim() || (jobs && !b.trim())) return;
    const dueAt = fromLocalInput(due);
    if (jobs) onAdd({ view, kind: "application", title: "Application submitted", dueAt, source: "manual", job: { company: a.trim(), role: b.trim(), stage: "applied", followUpAt: dueAt, nextAction: dueAt ? "Follow up" : null } });
    else onAdd({ view, kind: view === "grader" ? "grading" : "assignment", title: a.trim(), published: true, course: b.trim() || null, dueAt, dueLabel: dueAt ? null : "No due date", source: "manual", progress: 0 });
  };
  return (
    <form className="quick-add" onSubmit={e => { e.preventDefault(); submit(); }} onKeyDown={e => e.key === "Escape" && onCancel()}>
      <input autoFocus value={a} onChange={e => setA(e.target.value)} placeholder={jobs ? "Company" : "What needs doing?"} aria-label={jobs ? "Company" : "Title"} />
      <input value={b} onChange={e => setB(e.target.value)} placeholder={jobs ? "Role" : "Course (optional)"} aria-label={jobs ? "Role" : "Course"} />
      <label className="qa-due"><span>{jobs ? "Follow up" : "Due"}</span><input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label>
      <div className="qa-actions"><button type="button" className="ghost" onClick={onCancel}>Cancel</button><button type="submit" className="primary">Add card</button></div>
    </form>
  );
}

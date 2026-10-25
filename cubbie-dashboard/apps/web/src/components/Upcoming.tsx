import type { Task } from "@cubbie/shared/types";
import { BUCKETS, bucketOf, dueInfo } from "../lib/dates";
import { datedItems } from "../lib/derive";

const VIEW_NAME = { student: "Coursework", grader: "Grading", jobs: "Job" } as const;

export function Upcoming({ tasks, onOpen, showView }: { tasks: Task[]; onOpen: (id: string) => void; showView: boolean }) {
  const now = new Date();
  const items = datedItems(tasks).filter(item => !item.at || Date.parse(item.at) >= now.getTime());
  const groups = BUCKETS.map(b => ({ b, items: items.filter(i => bucketOf(i.at, now) === b) })).filter(g => g.items.length);
  if (!groups.length) return <p className="empty big">No tasks match this view. Add a card on the board, or text Cubbie “add …”.</p>;
  return (
    <div className="upcoming">
      {groups.map(g => (
        <section key={g.b} className={`bucket b-${g.b.replace(/\s/g, "").toLowerCase()}`}>
          <h3>{g.b}<span className="n">{g.items.length}</span></h3>
          <ul>
            {g.items.map(i => {
              const due = dueInfo(i.at, now, i.task.dueLabel);
              const who = i.task.job ? `${i.task.job.company}, ${i.task.job.role}` : `${i.task.course ?? "Personal"}, ${i.task.title}`;
              return (
                <li key={i.key}>
                  <button onClick={() => onOpen(i.task.id)}>
                    <span className={`when tone-${due.tone}`}>{due.label}</span>
                    <span className="what"><strong>{i.task.job ? i.label : i.task.title}</strong><span>{i.task.job ? who : i.label !== i.task.title ? `${i.label}, ${i.task.course}` : i.task.course ?? "Personal"}</span></span>
                    {i.task.view === "student" && <span className="vtag">{i.task.status === "done" ? "Submitted" : i.task.status === "in_progress" ? "In progress" : "Todo"}</span>}
                    {showView && <span className="vtag">{VIEW_NAME[i.task.view]}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

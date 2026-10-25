import type { Task } from "@cubbie/shared/types";
import { BUCKETS, bucketOf, dueInfo } from "../lib/dates";
import { datedItems } from "../lib/derive";

const VIEW_NAME = { student: "Class", grader: "Grading", jobs: "Job" } as const;

export function Upcoming({ tasks, onOpen, showView }: { tasks: Task[]; onOpen: (id: string) => void; showView: boolean }) {
  const items = datedItems(tasks);
  const groups = BUCKETS.map(b => ({ b, items: items.filter(i => bucketOf(i.at) === b) })).filter(g => g.items.length);
  if (!groups.length) return <p className="empty big">Nothing open here. Add a card on the board, or text Cubbie “add …”.</p>;
  return (
    <div className="upcoming">
      {groups.map(g => (
        <section key={g.b} className={`bucket b-${g.b.replace(/\s/g, "").toLowerCase()}`}>
          <h3>{g.b}<span className="n">{g.items.length}</span></h3>
          <ul>
            {g.items.map(i => {
              const due = dueInfo(i.at, new Date(), i.task.dueLabel);
              const who = i.task.job ? `${i.task.job.company}, ${i.task.job.role}` : `${i.task.course ?? "Personal"}, ${i.task.title}`;
              return (
                <li key={i.key}>
                  <button onClick={() => onOpen(i.task.id)}>
                    <span className={`when tone-${due.tone}`}>{due.label}</span>
                    <span className="what"><strong>{i.task.job ? i.label : i.task.title}</strong><span>{i.task.job ? who : i.label !== i.task.title ? `${i.label}, ${i.task.course}` : i.task.course ?? "Personal"}</span></span>
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

import type { Task } from "@cubbie/shared/types";
import { addDays, dayDiff, fmtTime, startOfDay } from "../lib/dates";
import { datedItems } from "../lib/derive";

const head = new Intl.DateTimeFormat(undefined, { weekday: "short" });

export function WeekView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const now = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(startOfDay(now), i));
  const items = datedItems(tasks).filter(i => i.at);
  const overdue = items.filter(i => Date.parse(i.at!) < now.getTime());
  return (
    <div className="week-wrap">
      {overdue.length > 0 && (
        <p className="overdue-strip">
          <strong>{overdue.length} overdue:</strong>{" "}
          {overdue.map((i, k) => <button key={i.key} onClick={() => onOpen(i.task.id)}>{i.task.job?.company ?? i.task.title}{k < overdue.length - 1 ? "," : ""}</button>)}
        </p>
      )}
      <div className="week">
        {days.map(d => {
          const list = items.filter(i => Date.parse(i.at!) >= now.getTime() && dayDiff(new Date(i.at!), d) === 0);
          return (
            <section key={d.toISOString()} className={`day ${dayDiff(d, now) === 0 ? "today" : ""}`}>
              <h3><span>{dayDiff(d, now) === 0 ? "Today" : head.format(d)}</span><b>{d.getDate()}</b></h3>
              {list.map(i => (
                <button key={i.key} className={`ev v-${i.task.view}`} onClick={() => onOpen(i.task.id)}>
                  <time>{fmtTime(new Date(i.at!))}</time>
                  <span>{i.task.job ? `${i.task.job.company}: ${i.label}` : i.task.title}</span>
                </button>
              ))}
              {!list.length && <p className="free">Free</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

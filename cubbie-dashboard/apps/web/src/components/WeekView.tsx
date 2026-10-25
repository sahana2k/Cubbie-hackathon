import type { Task } from "@cubbie/shared/types";
import { addDays, dayDiff, fmtDay, fmtTime, startOfDay } from "../lib/dates";
import { datedItems, type DatedItem } from "../lib/derive";

const head = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const courseName = (course: string) => course
  .replace(/\s*\([^)]*\b(?:spring|summer|fall|autumn|winter|semester|session|term)\b[^)]*\)/gi, "")
  .replace(/^([A-Z]{2,}\s*\d{3}[A-Z]?)\s*:\s*/, "$1 ")
  .trim();

export function WeekView({ tasks, onOpen }: { tasks: Task[]; onOpen: (id: string) => void }) {
  const now = new Date();
  const start = startOfDay(now);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const items = datedItems(tasks);
  const card = (item: DatedItem) => (
    <button key={item.key} className={`ev v-${item.task.view}`} onClick={() => onOpen(item.task.id)}>
      {item.at && Number.isFinite(Date.parse(item.at)) && <time>{fmtTime(new Date(item.at))}</time>}
      <span className="ev-title" title={item.task.job ? `${item.task.job.company}: ${item.label}` : item.task.title}>{item.task.job ? `${item.task.job.company}: ${item.label}` : item.task.title}</span>
      {item.task.course && <small>{courseName(item.task.course)}</small>}
    </button>
  );
  return (
    <div className="week-wrap">
      <p className="fine">Today through {fmtDay(addDays(start, 6))}.</p>
      <div className="week">
        {days.map(d => {
          const list = items.filter(i => i.at && dayDiff(new Date(i.at), d) === 0);
          return (
            <section key={d.toISOString()} className={`day ${dayDiff(d, now) === 0 ? "today" : ""}`}>
              <h3><span>{dayDiff(d, now) === 0 ? "Today" : head.format(d)}</span><b>{d.getDate()}</b></h3>
              {list.map(card)}
              {!list.length && <p className="free">Free</p>}
            </section>
          );
        })}
      </div>

    </div>
  );
}

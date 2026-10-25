const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });

export const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export function dayDiff(target: Date, now: Date) {
  return Math.round((startOfDay(target).getTime() - startOfDay(now).getTime()) / 86_400_000);
}
export function fmtTime(d: Date) { return timeFmt.format(d).replace(/\s?AM/, " am").replace(/\s?PM/, " pm"); }
export function fmtDay(d: Date) { return dayFmt.format(d); }

export type Tone = "overdue" | "today" | "soon" | "later" | "none";

export function dueInfo(iso: string | null | undefined, now = new Date(), fallback?: string | null): { label: string; tone: Tone } {
  if (!iso) return { label: fallback || "No due date", tone: "none" };
  const d = new Date(iso);
  const diff = dayDiff(d, now);
  if (d.getTime() < now.getTime()) {
    if (diff === 0) return { label: `Was due ${fmtTime(d)}`, tone: "overdue" };
    if (diff === -1) return { label: "Overdue since yesterday", tone: "overdue" };
    return { label: `Overdue ${-diff} days`, tone: "overdue" };
  }
  if (diff === 0) return { label: `Today ${fmtTime(d)}`, tone: "today" };
  if (diff === 1) return { label: `Tomorrow ${fmtTime(d)}`, tone: "soon" };
  if (diff < 7) return { label: `${weekdayFmt.format(d)} ${fmtTime(d)}`, tone: diff <= 3 ? "soon" : "later" };
  return { label: fmtDay(d), tone: "later" };
}

export const BUCKETS = ["Overdue", "Today", "Tomorrow", "This week", "Later", "No date"] as const;
export type Bucket = (typeof BUCKETS)[number];

export function bucketOf(iso: string | null | undefined, now = new Date()): Bucket {
  if (!iso) return "No date";
  const d = new Date(iso);
  if (d.getTime() < now.getTime()) return "Overdue";
  const diff = dayDiff(d, now);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff < 7) return "This week";
  return "Later";
}

export function chatStamp(iso: string, now = new Date()) {
  const d = new Date(iso);
  const diff = dayDiff(d, now);
  if (diff === 0) return `Today ${fmtTime(d)}`;
  if (diff === -1) return `Yesterday ${fmtTime(d)}`;
  return `${fmtDay(d)} ${fmtTime(d)}`;
}

/** Value for <input type="datetime-local"> in the viewer's zone. */
export function toLocalInput(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string) { return v ? new Date(v).toISOString() : null; }

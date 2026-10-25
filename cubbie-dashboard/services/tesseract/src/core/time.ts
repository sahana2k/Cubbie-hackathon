import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';

export const HOUR = 3_600_000;
export const MINUTE = 60_000;

/** Parse natural language ("Friday 11:59pm", "tomorrow 6pm", "2026-11-03 17:00") in a timezone. Future-biased. */
export function parseWhen(text: string, tz: string, ref: number = Date.now()): number | null {
  if (!text) return null;
  const trimmed = text.trim();
  // ISO strings with explicit offset/Z are taken as-is
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const t = Date.parse(trimmed);
    return Number.isNaN(t) ? null : t;
  }
  // ISO without offset → interpret in project timezone
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{1,2}:\d{2}(:\d{2})?)?$/.test(trimmed)) {
    const dt = DateTime.fromISO(trimmed.replace(' ', 'T'), { zone: tz });
    if (!dt.isValid) return null;
    return (trimmed.length <= 10 ? dt.set({ hour: 23, minute: 59 }) : dt).toMillis();
  }
  const offset = DateTime.fromMillis(ref, { zone: tz }).offset; // minutes
  const results = chrono.parse(trimmed, { instant: new Date(ref), timezone: offset }, { forwardDate: true });
  if (!results.length) return null;
  const r = results[0];
  const d = r.start.date();
  // A bare date ("Friday") means end of that day, which is how students mean deadlines.
  if (!r.start.isCertain('hour')) {
    const local = DateTime.fromJSDate(d, { zone: tz }).set({ hour: 23, minute: 59, second: 0, millisecond: 0 });
    return local.toMillis();
  }
  return d.getTime();
}

/** Discord dynamic timestamp: renders in every reader's own timezone. */
export function ts(ms: number | null | undefined, style: 'f' | 'F' | 'R' | 't' | 'd' | 'D' = 'f'): string {
  if (!ms) return 'no date';
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}
export const tsBoth = (ms: number | null | undefined) => (ms ? `${ts(ms, 'f')} (${ts(ms, 'R')})` : 'no date');

/** Plain-text local time, for Claude prompts and logs. */
export function localStr(ms: number | null | undefined, tz: string): string {
  if (!ms) return 'none';
  return DateTime.fromMillis(ms, { zone: tz }).toFormat("ccc LLL d, h:mm a ZZZZ");
}
export function localIso(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toISO({ suppressMilliseconds: true })!;
}

const DAY_TOKENS: [RegExp, number][] = [
  [/^(mon|monday|m)$/i, 1], [/^(tue|tues|tuesday|t|tu)$/i, 2], [/^(wed|weds|wednesday|w)$/i, 3],
  [/^(thu|thur|thurs|thursday|th|r)$/i, 4], [/^(fri|friday|f)$/i, 5], [/^(sat|saturday|sa)$/i, 6], [/^(sun|sunday|su)$/i, 7],
];

/** "MWF", "TTh", "TR", "Mon,Wed", "tue thu", "weekdays" → ISO weekdays */
export function parseDays(input: string): number[] {
  const s = input.trim().toLowerCase();
  if (s === 'weekdays') return [1, 2, 3, 4, 5];
  if (s === 'weekends') return [6, 7];
  if (s === 'daily' || s === 'everyday') return [1, 2, 3, 4, 5, 6, 7];
  const out = new Set<number>();
  const parts = s.split(/[\s,/&+]+|and/).filter(Boolean);
  for (const part of parts) {
    const whole = DAY_TOKENS.find(([re]) => re.test(part));
    if (whole && part.length > 2) { out.add(whole[1]); continue; }
    // compact form like "mwf", "tth", "tr", "mw"
    let i = 0;
    while (i < part.length) {
      const two = part.slice(i, i + 2);
      if (two === 'th' || two === 'tu' || two === 'sa' || two === 'su') {
        out.add(two === 'th' ? 4 : two === 'tu' ? 2 : two === 'sa' ? 6 : 7); i += 2; continue;
      }
      const map: Record<string, number> = { m: 1, t: 2, w: 3, r: 4, f: 5, s: 6, u: 7 };
      if (map[part[i]]) out.add(map[part[i]]);
      i += 1;
    }
  }
  return [...out].sort();
}

/** "10:30am", "13:15", "6pm", "6" → minutes after midnight */
export function parseClock(input: string): number | null {
  const m = input.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3];
  if (ap?.startsWith('p') && h < 12) h += 12;
  if (ap?.startsWith('a') && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function clockStr(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}
export const WEEKDAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

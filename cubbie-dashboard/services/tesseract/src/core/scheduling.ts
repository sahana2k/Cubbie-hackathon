import { DateTime } from 'luxon';
import type { BusyBlock, MeetingOption } from '../db/repo';

export interface SlotSearch {
  memberIds: string[];
  busy: BusyBlock[];
  tz: string;
  durationMin: number;
  from: number;          // search start (ms)
  days: number;          // how many days ahead
  earliestHour?: number; // local hour, default 9
  latestHour?: number;   // local hour the meeting must END by, default 22
  stepMin?: number;
  maxOptions?: number;
  maxPerDay?: number;
}

export interface ScoredSlot extends MeetingOption { freeIds: string[]; }

/** Members free for [startMin, endMin) on an ISO weekday, given recurring busy blocks. */
export function freeMembers(memberIds: string[], busy: BusyBlock[], weekday: number, startMin: number, endMin: number): string[] {
  return memberIds.filter(id => !busy.some(b => b.discord_id === id && b.weekday === weekday && b.start_min < endMin && b.end_min > startMin));
}

/**
 * Finds the best meeting slots around everyone's recurring class/work schedule.
 * Ranking: most people free → earliest. Options are spread out (max N per day, no overlaps).
 * Private labels of busy blocks are never read here, so they can't leak into the chat.
 */
export function findMeetingOptions(q: SlotSearch): ScoredSlot[] {
  const step = q.stepMin ?? 30;
  const earliest = (q.earliestHour ?? 9) * 60;
  const latest = (q.latestHour ?? 22) * 60;
  const maxOptions = q.maxOptions ?? 5;
  const maxPerDay = q.maxPerDay ?? 2;
  const minStart = q.from + 60 * 60_000; // at least an hour of notice
  const total = q.memberIds.length;

  const candidates: ScoredSlot[] = [];
  const startDay = DateTime.fromMillis(q.from, { zone: q.tz }).startOf('day');
  for (let d = 0; d <= q.days; d++) {
    const day = startDay.plus({ days: d });
    for (let m = earliest; m + q.durationMin <= latest; m += step) {
      const start = day.plus({ minutes: m });
      if (start.toMillis() < minStart) continue;
      const freeIds = freeMembers(q.memberIds, q.busy, day.weekday, m, m + q.durationMin);
      candidates.push({ start: start.toMillis(), end: start.plus({ minutes: q.durationMin }).toMillis(), freeCount: freeIds.length, total, freeIds });
    }
  }
  candidates.sort((a, b) => b.freeCount - a.freeCount || a.start - b.start);

  const chosen: ScoredSlot[] = [];
  const perDay = new Map<string, number>();
  for (const c of candidates) {
    if (chosen.length >= maxOptions) break;
    const dayKey = DateTime.fromMillis(c.start, { zone: q.tz }).toISODate()!;
    if ((perDay.get(dayKey) ?? 0) >= maxPerDay) continue;
    // keep options at least 2h apart so they're meaningfully different
    if (chosen.some(o => Math.abs(o.start - c.start) < 2 * 3_600_000)) continue;
    chosen.push(c);
    perDay.set(dayKey, (perDay.get(dayKey) ?? 0) + 1);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

/** Builds an RFC 5545 calendar invite so students can add the meeting to any calendar app. */
export function buildIcs(opts: { uid: string; title: string; start: number; end: number; description?: string; location?: string }): string {
  const fmt = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tesseract//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${opts.uid}@mergemates`, `DTSTAMP:${fmt(Date.now())}`, `DTSTART:${fmt(opts.start)}`, `DTEND:${fmt(opts.end)}`,
    `SUMMARY:${esc(opts.title)}`, opts.description ? `DESCRIPTION:${esc(opts.description)}` : '', opts.location ? `LOCATION:${esc(opts.location)}` : '',
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${esc(opts.title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

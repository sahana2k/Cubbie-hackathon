import { describe, expect, it, beforeEach } from 'vitest';
import { DateTime } from 'luxon';
import * as repo from '../src/db/repo';
import * as actions from '../src/core/actions';
import { lockMeeting, startMeetingPoll } from '../src/core/meetings';
import { buildIcs, findMeetingOptions } from '../src/core/scheduling';
import { createsCycle } from '../src/core/constraints';
import { parseClock, parseDays, parseWhen, HOUR } from '../src/core/time';
import { ALEX, MAYA, SAM, TZ, freshProject } from './helpers';

describe('time parsing', () => {
  const ref = DateTime.fromISO('2026-10-24T20:00:00', { zone: TZ }).toMillis(); // Saturday evening
  it('treats a bare weekday as end of that day, in the future', () => {
    const t = DateTime.fromMillis(parseWhen('Friday', TZ, ref)!, { zone: TZ });
    expect(t.toFormat('ccc yyyy-LL-dd HH:mm')).toBe('Fri 2026-10-30 23:59');
  });
  it('parses weekday + time in the project timezone', () => {
    const t = DateTime.fromMillis(parseWhen('wednesday 6pm', TZ, ref)!, { zone: TZ });
    expect(t.toFormat('ccc HH:mm')).toBe('Wed 18:00');
  });
  it('accepts ISO with offset from Claude', () => {
    expect(parseWhen('2026-10-28T18:00:00-07:00', TZ)).toBe(Date.parse('2026-10-29T01:00:00Z'));
  });
  it('parses class-schedule shorthand', () => {
    expect(parseDays('MWF')).toEqual([1, 3, 5]);
    expect(parseDays('TTh')).toEqual([2, 4]);
    expect(parseDays('TR')).toEqual([2, 4]);
    expect(parseDays('Mon/Wed')).toEqual([1, 3]);
    expect(parseClock('10:30am')).toBe(630);
    expect(parseClock('1:15pm')).toBe(13 * 60 + 15);
    expect(parseClock('12am')).toBe(0);
  });
});

describe('meeting slot finder', () => {
  it('avoids everyone\'s classes and ranks all-free slots first', () => {
    const from = DateTime.fromISO('2026-10-26T08:00:00', { zone: TZ }).toMillis(); // Monday
    const busy: repo.BusyBlock[] = [
      // Alex and Maya busy all weekday daytime except Monday 5-7pm window
      ...[1, 2, 3, 4, 5].map((d, i) => ({ id: i, project_id: 1, discord_id: ALEX, weekday: d, start_min: 9 * 60, end_min: 17 * 60, label: 'secret class' })),
      ...[1, 2, 3, 4, 5].map((d, i) => ({ id: 10 + i, project_id: 1, discord_id: MAYA, weekday: d, start_min: 19 * 60, end_min: 22 * 60, label: 'work' })),
    ];
    const opts = findMeetingOptions({ memberIds: [ALEX, MAYA, SAM], busy, tz: TZ, durationMin: 60, from, days: 1, earliestHour: 9, latestHour: 22 });
    expect(opts.length).toBeGreaterThan(0);
    const top = opts.filter(o => o.freeCount === 3);
    expect(top.length).toBeGreaterThan(0);
    for (const o of top) {
      const h = DateTime.fromMillis(o.start, { zone: TZ }).hour;
      expect(h).toBeGreaterThanOrEqual(17);
      expect(h).toBeLessThan(19);
    }
  });
  it('produces a valid calendar invite', () => {
    const ics = buildIcs({ uid: 'x', title: 'Demo, run-through', start: Date.parse('2026-10-30T00:00:00Z'), end: Date.parse('2026-10-30T01:00:00Z') });
    expect(ics).toContain('DTSTART:20261030T000000Z');
    expect(ics).toContain('SUMMARY:Demo\\, run-through');
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
  });
});

describe('task orchestration with consent', () => {
  let p: repo.Project;
  beforeEach(() => { p = freshProject(); });

  it('only commits a task after the owner confirms', () => {
    const r = actions.proposeTask(p, { title: 'Presentation slides', owner_id: MAYA, due_at: Date.now() + 3 * 86_400_000, proposedBy: ALEX });
    expect(r.task.status).toBe('proposed');
    expect(r.decision!.required_approvers).toEqual([MAYA]);
    expect(() => actions.voteOnDecision(r.decision!.id, SAM, true)).toThrow(/Only/);
    const v = actions.voteOnDecision(r.decision!.id, MAYA, true);
    expect(v.resolved).toBe(true);
    expect(repo.getTask(r.task.id)!.status).toBe('confirmed');
    expect(repo.listPendingReminders(p.id).some(x => x.kind === 'task_due_soon' && x.recipient_id === MAYA)).toBe(true);
  });

  it('declining frees the task for others', () => {
    const r = actions.proposeTask(p, { title: 'Testing', owner_id: SAM, proposedBy: ALEX });
    actions.voteOnDecision(r.decision!.id, SAM, false);
    expect(repo.getTask(r.task.id)!.status).toBe('declined');
    actions.claimTask(p, r.task.id, MAYA);
    expect(repo.getTask(r.task.id)).toMatchObject({ owner_id: MAYA, status: 'confirmed' });
  });

  it('tracks dependencies, blocks, and unblocks with a notification', () => {
    const research = actions.proposeTask(p, { title: 'Research', owner_id: ALEX, due_at: Date.now() + 2 * 86_400_000, proposedBy: ALEX, selfConsent: true }).task;
    const slides = actions.proposeTask(p, { title: 'Slides', owner_id: MAYA, due_at: Date.now() + 4 * 86_400_000, proposedBy: MAYA, selfConsent: true }).task;
    const dep = actions.addDependencyAction(p, research.id, slides.id, 'needs research', MAYA);
    expect(dep.conflicts).toEqual([]);
    expect(repo.getTask(slides.id)!.status).toBe('blocked');
    expect(() => actions.completeTask(p, research.id, MAYA)).toThrow(/Only Alex/);
    const outs = actions.completeTask(p, research.id, ALEX);
    expect(repo.getTask(slides.id)!.status).toBe('confirmed');
    expect(outs.map(o => (o as any).text).join('\n')).toMatch(/Slides\*\* is unblocked/);
  });

  it('refuses circular dependencies', () => {
    const a = actions.proposeTask(p, { title: 'A', owner_id: ALEX, proposedBy: ALEX, selfConsent: true }).task;
    const b = actions.proposeTask(p, { title: 'B', owner_id: MAYA, proposedBy: MAYA, selfConsent: true }).task;
    actions.addDependencyAction(p, a.id, b.id, null, ALEX);
    expect(createsCycle(p.id, b.id, a.id)).toBe(true);
    expect(() => actions.addDependencyAction(p, b.id, a.id, null, ALEX)).toThrow(/circular/);
  });

  it('a slipping deadline needs approval from blocked teammates and reports the ripple', () => {
    const research = actions.proposeTask(p, { title: 'Research', owner_id: ALEX, due_at: Date.now() + 2 * 86_400_000, proposedBy: ALEX, selfConsent: true }).task;
    const slides = actions.proposeTask(p, { title: 'Slides', owner_id: MAYA, due_at: Date.now() + 3 * 86_400_000, proposedBy: MAYA, selfConsent: true }).task;
    actions.addDependencyAction(p, research.id, slides.id, null, MAYA);
    const newDue = Date.now() + 3 * 86_400_000 - 2 * HOUR;
    const r = actions.setDeadlineDirect(p, research.id, newDue, ALEX); // owner tries to move it directly
    const d = repo.getDecision((r.outs[0] as any).decisionId)!;
    expect(d.kind).toBe('change_deadline');
    expect(d.required_approvers.sort()).toEqual([ALEX, MAYA].sort());
    expect(d.conflicts.join(' ')).toMatch(/Slides.*waiting on this/);
    actions.voteOnDecision(d.id, ALEX, true);
    expect(repo.getTask(research.id)!.due_at).not.toBe(newDue);
    const v = actions.voteOnDecision(d.id, MAYA, true);
    expect(repo.getTask(research.id)!.due_at).toBe(newDue);
    expect(v.outs.map(o => (o as any).text).join()).toMatch(/push it too/);
  });

  it('flags overload when one person gets too much at once', () => {
    const soon = Date.now() + 86_400_000;
    actions.proposeTask(p, { title: 'T1', owner_id: SAM, due_at: soon, proposedBy: SAM, selfConsent: true });
    actions.proposeTask(p, { title: 'T2', owner_id: SAM, due_at: soon + HOUR, proposedBy: SAM, selfConsent: true });
    const r = actions.proposeTask(p, { title: 'T3', owner_id: SAM, due_at: soon + 2 * HOUR, proposedBy: ALEX });
    expect(r.conflicts.join()).toMatch(/Sam would have 3 tasks/);
  });

  it('reassignment needs the new owner (and old owner) to agree', () => {
    const t = actions.proposeTask(p, { title: 'Research', owner_id: ALEX, due_at: Date.now() + 86_400_000, proposedBy: ALEX, selfConsent: true }).task;
    const r = actions.proposeReassignment(p, t.id, SAM, 'Alex is sick', MAYA);
    const d = repo.getDecision((r.outs[0] as any).decisionId)!;
    expect(d.required_approvers.sort()).toEqual([ALEX, SAM].sort());
    actions.voteOnDecision(d.id, SAM, true);
    actions.voteOnDecision(d.id, ALEX, true);
    expect(repo.getTask(t.id)!.owner_id).toBe(SAM);
  });

  it('readiness compares deliverables with the rubric', () => {
    const [report, slides] = repo.replaceRequirements(p.id, [{ title: 'Research report', points: 40 }, { title: 'Slides', points: 30 }]);
    const t = actions.proposeTask(p, { title: 'Report', owner_id: ALEX, requirement_id: report.id, proposedBy: ALEX, selfConsent: true }).task;
    let r = actions.readiness(p);
    expect(r.requirements.find(x => x.req.id === report.id)!.state).toBe('in_progress');
    expect(r.unowned.map(x => x.req.id)).toEqual([slides.id]);
    actions.completeTask(p, t.id, ALEX);
    r = actions.readiness(p);
    expect(r.requirements.find(x => x.req.id === report.id)!.state).toBe('done');
    expect(p.submitted_at).toBeNull();
  });
});

describe('meetings', () => {
  it('auto-confirms when every voter picked the locked slot, otherwise asks the rest', () => {
    const p = freshProject();
    const { meetingId } = startMeetingPoll(p, { title: 'Demo run-through', durationMin: 60, createdBy: ALEX });
    repo.toggleVote(meetingId, 0, ALEX); repo.toggleVote(meetingId, 0, MAYA); repo.toggleVote(meetingId, 1, SAM);
    const outs = lockMeeting(p, meetingId, 0, ALEX);
    expect(outs[0].kind).toBe('decision');
    const d = repo.getDecision((outs[0] as any).decisionId)!;
    expect(d.approvals.sort()).toEqual([ALEX, MAYA].sort());
    const v = actions.voteOnDecision(d.id, SAM, true);
    expect(v.outs[0].kind).toBe('meeting_confirmed');
    expect(repo.getMeeting(meetingId)!.status).toBe('confirmed');

    const { meetingId: m2 } = startMeetingPoll(p, { title: 'Quick sync', durationMin: 30, createdBy: ALEX });
    repo.toggleVote(m2, 2, ALEX); repo.toggleVote(m2, 2, SAM);
    const outs2 = lockMeeting(p, m2, null, SAM);
    expect(outs2[0].kind).toBe('meeting_confirmed');
  });
});

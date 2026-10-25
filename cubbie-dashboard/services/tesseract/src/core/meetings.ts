import * as repo from '../db/repo';
import type { Project } from '../db/repo';
import { ActionError, voteOnDecision, type Out } from './actions';
import { findMeetingOptions } from './scheduling';
import { localStr } from './time';

export interface StartPollInput {
  title: string; durationMin: number; daysAhead?: number; earliestHour?: number; latestHour?: number;
  createdBy: string; channelId?: string | null; from?: number;
}

/** Meeting Coordinator's deterministic half: propose slots that avoid everyone's classes. */
export function startMeetingPoll(project: Project, input: StartPollInput): { outs: Out[]; meetingId: number; summary: string } {
  const members = repo.listMembers(project.id);
  if (members.length === 0) throw new ActionError('No members yet — everyone should run `/join` first.');
  const options = findMeetingOptions({
    memberIds: members.map(m => m.discord_id), busy: repo.listBusyBlocks(project.id), tz: project.timezone,
    durationMin: input.durationMin, from: input.from ?? Date.now(), days: input.daysAhead ?? 5,
    earliestHour: input.earliestHour, latestHour: input.latestHour, maxOptions: 5,
  });
  if (!options.length) throw new ActionError('No slots in that window. Try a wider window (more days or hours).');
  const meeting = repo.createMeeting({
    project_id: project.id, title: input.title, duration_min: input.durationMin, created_by: input.createdBy, channel_id: input.channelId ?? project.channel_id,
    options: options.map(({ start, end, freeCount, total }) => ({ start, end, freeCount, total })),
  });
  const withClasses = new Set(repo.listBusyBlocks(project.id).map(b => b.discord_id)).size;
  const summary = options.map((o, i) => `${i + 1}. ${localStr(o.start, project.timezone)} — ${o.freeCount}/${o.total} free by class schedule`).join('\n');
  repo.logAgent(project.id, 'Meeting Coordinator', 'poll_started', { meeting: meeting.id, options: options.length, schedulesKnown: withClasses });
  return { outs: [{ kind: 'meeting_poll', meetingId: meeting.id }], meetingId: meeting.id, summary };
}

export function tallyVotes(meetingId: number) {
  const m = repo.getMeeting(meetingId)!;
  const votes = repo.votesFor(meetingId);
  const voters = [...new Set(votes.map(v => v.discord_id))];
  const perOption = m.options.map((_, i) => votes.filter(v => v.option_index === i).map(v => v.discord_id));
  let best = -1;
  perOption.forEach((v, i) => { if (best === -1 || v.length > perOption[best].length || (v.length === perOption[best].length && m.options[i].freeCount > m.options[best].freeCount)) best = i; });
  return { meeting: m, voters, perOption, best };
}

/**
 * Lock in a slot. Everyone who voted is a required approver; people who already voted for
 * that exact slot are counted as approving. If that's everyone, it's confirmed immediately.
 */
export function lockMeeting(project: Project, meetingId: number, optionIndex: number | null, by: string): Out[] {
  const { meeting, voters, perOption, best } = tallyVotes(meetingId);
  if (meeting.project_id !== project.id) throw new ActionError('Meeting not found in this project.');
  if (meeting.status === 'confirmed') throw new ActionError('That meeting is already confirmed.');
  const idx = optionIndex ?? best;
  if (idx < 0 || idx >= meeting.options.length) throw new ActionError('Pick a valid option.');
  const approvers = [...new Set([...voters, by])];
  const yes = perOption[idx];
  const opt = meeting.options[idx];
  const missing = approvers.filter(a => !yes.includes(a));
  const conflicts = missing.length ? [`${missing.map(a => repo.memberName(project.id, a)).join(', ')} didn't vote for this slot — they need to confirm.`] : [];
  const d = repo.createDecision({
    project_id: project.id, kind: 'confirm_meeting', payload: { meeting_id: meeting.id, option_index: idx }, proposed_by: by, channel_id: meeting.channel_id,
    summary: `Lock in **${meeting.title}** for <t:${Math.floor(opt.start / 1000)}:F>? (${yes.length}/${approvers.length} already picked it)`,
    required_approvers: approvers, conflicts,
  });
  repo.updateMeeting(meeting.id, { status: 'confirming' });
  const outs: Out[] = [];
  let resolved = false;
  for (const a of approvers.filter(x => yes.includes(x))) {
    const r = voteOnDecision(d.id, a, true);
    if (r.resolved) { outs.push(...r.outs); resolved = true; break; }
  }
  if (!resolved) outs.unshift({ kind: 'decision', decisionId: d.id });
  return outs;
}

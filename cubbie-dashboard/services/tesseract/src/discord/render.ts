import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageCreateOptions } from 'discord.js';
import * as repo from '../db/repo';
import type { Decision, Project, Task } from '../db/repo';
import { projectStatus, readiness } from '../core/actions';
import { tallyVotes } from '../core/meetings';
import { buildIcs } from '../core/scheduling';
import { ts, tsBoth } from '../core/time';

export const COLORS = { brand: 0x7c5cff, ok: 0x2ecc71, warn: 0xf1c40f, bad: 0xe74c3c, info: 0x3498db } as const;

const STATUS_ICON: Record<string, string> = { proposed: '💭', confirmed: '📌', in_progress: '🔨', blocked: '🚧', done: '✅', overdue: '⏰', declined: '↩️' };
const mention = (id: string | null) => (id ? `<@${id}>` : '*unassigned*');

export function taskLine(t: Task, withOwner = true): string {
  const due = t.due_at ? ` · due ${ts(t.due_at, 'R')}` : '';
  return `${STATUS_ICON[t.status] ?? '•'} **#${t.id}** ${t.title}${withOwner ? ` — ${mention(t.owner_id)}` : ''}${due}`;
}

export function decisionMessage(d: Decision): MessageCreateOptions {
  const kindTitle: Record<string, string> = {
    assign_task: '📋 Task assignment', reassign_task: '🔁 Reassignment proposal', change_deadline: '🗓️ Deadline change',
    confirm_meeting: '📅 Lock in meeting', confirm_submission: '🏁 Confirm submission',
  };
  const waiting = d.required_approvers.filter(a => !d.approvals.includes(a));
  const embed = new EmbedBuilder()
    .setColor(d.status === 'approved' ? COLORS.ok : d.status === 'rejected' ? COLORS.bad : d.conflicts.length ? COLORS.warn : COLORS.brand)
    .setTitle(kindTitle[d.kind] ?? 'Proposal')
    .setDescription(d.summary)
    .setFooter({ text: `Proposal D${d.id} · proposed by ${/^\d+$/.test(d.proposed_by) ? 'a teammate' : d.proposed_by}` });
  if (d.conflicts.length) embed.addFields({ name: '⚠️ Heads-up', value: d.conflicts.map(c => `• ${c}`).join('\n').slice(0, 1024) });
  if (d.status === 'pending') embed.addFields({ name: 'Waiting on', value: waiting.map(mention).join(' ') || '—', inline: true });
  if (d.approvals.length) embed.addFields({ name: 'Approved', value: d.approvals.map(mention).join(' '), inline: true });
  if (d.status !== 'pending') embed.addFields({ name: 'Result', value: d.status === 'approved' ? '✅ Approved' : d.status === 'rejected' ? '❌ Declined' : d.status, inline: true });

  const components = d.status === 'pending' ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`dec:${d.id}:y`).setLabel(d.kind === 'assign_task' ? "I'm in" : 'Approve').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`dec:${d.id}:n`).setLabel(d.kind === 'assign_task' ? "Can't take it" : 'Decline').setStyle(ButtonStyle.Secondary).setEmoji('✋'),
  )] : [];
  return { content: d.status === 'pending' ? waiting.map(mention).join(' ') : undefined, embeds: [embed], components, allowedMentions: { users: waiting } };
}

export function claimBoardMessage(project: Project, taskIds: number[]): MessageCreateOptions {
  const tasks = taskIds.map(id => repo.getTask(id)).filter((t): t is Task => !!t && !t.owner_id && t.status !== 'done').slice(0, 20);
  const embed = new EmbedBuilder().setColor(COLORS.brand).setTitle('🙋 Claim board — who wants what?')
    .setDescription(tasks.map(t => `**#${t.id} ${t.title}**${t.due_at ? ` · due ${tsBoth(t.due_at)}` : ''}${t.description ? `\n  ${t.description.slice(0, 120)}` : ''}`).join('\n') || 'Everything is claimed 🎉')
    .setFooter({ text: 'Clicking a button = you commit to that task. You can still change the deadline later.' });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < tasks.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(tasks.slice(i, i + 5).map(t =>
      new ButtonBuilder().setCustomId(`claim:${t.id}`).setLabel(`#${t.id} ${t.title}`.slice(0, 80)).setStyle(ButtonStyle.Primary))));
  }
  return { embeds: [embed], components: rows.slice(0, 4) };
}

export function meetingPollMessage(meetingId: number): MessageCreateOptions {
  const { meeting, perOption, best, voters } = tallyVotes(meetingId);
  const lines = meeting.options.map((o, i) => {
    const v = perOption[i];
    const fit = o.freeCount === o.total ? '🟢' : o.freeCount >= o.total - 1 ? '🟡' : '🔴';
    return `**${i + 1}.** ${ts(o.start, 'F')} ${fit} ${o.freeCount}/${o.total} clear of classes · 🗳️ ${v.length}${v.length ? ` (${v.map(mention).join(' ')})` : ''}`;
  });
  const embed = new EmbedBuilder().setColor(meeting.status === 'confirmed' ? COLORS.ok : COLORS.info)
    .setTitle(`📅 ${meeting.title} · ${meeting.duration_min} min`)
    .setDescription(`${lines.join('\n')}\n\nTap every slot you can make. ${voters.length ? `${voters.length} voted so far.` : ''}\n🟢 everyone's free by class schedule · 🟡 one conflict · 🔴 several`)
    .setFooter({ text: `Meeting M${meeting.id} · class times stay private — only free/busy is used` });
  if (meeting.status === 'confirmed' && meeting.confirmed_start) embed.addFields({ name: 'Confirmed', value: tsBoth(meeting.confirmed_start) });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (meeting.status !== 'confirmed') {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(meeting.options.map((_, i) =>
      new ButtonBuilder().setCustomId(`mvote:${meeting.id}:${i}`).setLabel(`${i + 1}`).setStyle(i === best && perOption[i].length ? ButtonStyle.Success : ButtonStyle.Secondary))));
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mlock:${meeting.id}`).setLabel('Lock in top choice').setEmoji('🔒').setStyle(ButtonStyle.Primary)));
  }
  return { embeds: [embed], components: rows };
}

export function meetingConfirmedMessage(meetingId: number): MessageCreateOptions {
  const m = repo.getMeeting(meetingId)!;
  const start = m.confirmed_start!;
  const ics = buildIcs({ uid: `meeting-${m.id}-${start}`, title: m.title, start, end: start + m.duration_min * 60_000, description: 'Scheduled by Tesseract' });
  const file = new AttachmentBuilder(Buffer.from(ics, 'utf8'), { name: `${m.title.replace(/[^\w]+/g, '-').toLowerCase()}.ics` });
  const embed = new EmbedBuilder().setColor(COLORS.ok).setTitle(`📅 Locked in: ${m.title}`)
    .setDescription(`${ts(start, 'F')} (${ts(start, 'R')}) · ${m.duration_min} min\nAdd it to your calendar with the attached invite. I'll remind everyone 24h and 1h before.`);
  return { embeds: [embed], files: [file] };
}

export function statusEmbed(project: Project): EmbedBuilder {
  const s = projectStatus(project);
  const r = readiness(project);
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
  const e = new EmbedBuilder().setColor(s.attention.some(a => a.rank === 0) ? COLORS.bad : s.attention.some(a => a.rank === 1) ? COLORS.warn : COLORS.ok)
    .setTitle(`Tesseract — ${project.name}`)
    .setDescription(`**Due:** ${tsBoth(project.final_deadline)}${project.submitted_at ? '\n🏁 **Submitted** ' + ts(project.submitted_at, 'f') : ''}`)
    .addFields({ name: 'Progress', value: `\`${bar}\` ${s.done} of ${s.total} tasks (${pct}%)` });
  const attn = s.attention.slice(0, 8).map(a => `${a.rank === 0 ? '🔴' : a.rank === 1 ? '🟠' : a.rank === 2 ? '🟡' : '⚪'} ${repo.memberName(project.id, a.task.owner_id)} — **${a.task.title}** ${a.reason}`);
  if (attn.length) e.addFields({ name: 'Needs attention', value: attn.join('\n').slice(0, 1024) });
  if (r.requirements.length) e.addFields({ name: 'Rubric coverage', value: r.requirements.map(x => `${x.state === 'done' ? '✅' : x.state === 'in_progress' ? '🔨' : '❗'} ${x.req.title}`).join('\n').slice(0, 1024) });
  e.addFields({ name: 'Next step', value: s.next });
  return e;
}

export function readinessEmbed(project: Project): EmbedBuilder {
  const r = readiness(project);
  const e = new EmbedBuilder().setColor(r.missing.length ? COLORS.warn : COLORS.ok).setTitle('📦 Submission readiness')
    .setDescription(`Final deadline: ${tsBoth(project.final_deadline)}\nSubmitter: ${mention(project.submitter_id)}${project.submission_instructions ? `\nHow to submit: ${project.submission_instructions}` : ''}`);
  if (!r.requirements.length) e.addFields({ name: 'Requirements', value: 'No rubric loaded yet. Upload one with `/rubric` or `/setup`.' });
  else e.addFields({ name: 'Requirements', value: r.requirements.map(x => {
    const owners = [...new Set(x.linked.map(t => t.owner_id).filter(Boolean))] as string[];
    return `${x.state === 'done' ? '✅' : x.state === 'in_progress' ? '🔨' : '❗'} **${x.req.title}**${x.req.points ? ` (${x.req.points} pts)` : ''} — ${x.state === 'missing' ? 'nobody owns this yet' : owners.map(mention).join(', ')}`;
  }).join('\n').slice(0, 1024) });
  e.addFields({ name: 'Submission', value: project.submitted_at ? `🏁 Confirmed ${ts(project.submitted_at, 'f')}${project.submission_proof ? ` — ${project.submission_proof}` : ''}` : '⏳ Not confirmed. The submitter must run `/submitted` — "it\'s ready" doesn\'t count.' });
  return e;
}

export function overdueButtons(taskId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`od:${taskId}:done`).setLabel('It\'s done').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`od:${taskId}:time`).setLabel('Need more time').setEmoji('🕐').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`od:${taskId}:help`).setLabel('Need help').setEmoji('🆘').setStyle(ButtonStyle.Secondary),
  );
}

import type { MessageCreateOptions } from 'discord.js';
import * as repo from '../db/repo';
import { OPEN_STATUSES, type Reminder } from '../db/repo';
import { readiness } from '../core/actions';
import { log } from '../core/log';
import { ts, tsBoth } from '../core/time';
import { overdueButtons, readinessEmbed } from '../discord/render';

/**
 * Reminder engine. Runs on an interval independent of chat activity.
 * Every reminder is re-validated against live state when it fires, so a task finished
 * early, reassigned, or rescheduled never produces a stale or wrong nudge.
 */
export interface Sender {
  channel(projectId: number, payload: MessageCreateOptions): Promise<unknown>;
  dm(userId: string, payload: MessageCreateOptions): Promise<boolean>;
}

const mention = (id: string | null) => (id ? `<@${id}>` : 'someone');

async function toPerson(sender: Sender, r: Reminder, payload: MessageCreateOptions) {
  if (r.private && r.recipient_id) {
    const ok = await sender.dm(r.recipient_id, payload);
    if (ok) return;
  }
  await sender.channel(r.project_id, { ...payload, allowedMentions: { users: r.recipient_id ? [r.recipient_id] : [] } });
}

export async function fireReminder(sender: Sender, r: Reminder, nowMs = Date.now()): Promise<'sent' | 'skipped'> {
  const project = repo.getProject(r.project_id);
  if (!project) return 'skipped';
  const task = r.task_id ? repo.getTask(r.task_id) : undefined;
  const taskOpen = task && OPEN_STATUSES.includes(task.status);

  switch (r.kind) {
    case 'task_due_soon': {
      if (!task || !taskOpen || task.owner_id !== r.recipient_id) return 'skipped';
      const waiting = repo.dependentsOf(task.id).map(d => repo.getTask(d.dependent_task_id)).filter(t => t && t.status !== 'done');
      const extra = waiting.length ? `\n${waiting.map(t => `${repo.memberName(project.id, t!.owner_id)}'s **${t!.title}**`).join(', ')} ${waiting.length > 1 ? 'are' : 'is'} waiting on it.` : '';
      await toPerson(sender, r, { content: `⏰ ${mention(task.owner_id)} quick reminder: **#${task.id} ${task.title}** is due ${tsBoth(task.due_at)}.${extra}\nDone? \`/done\` · Need more time? Just tell me.` });
      return 'sent';
    }
    case 'dependency_risk': {
      if (!task || !taskOpen || task.status === 'in_progress') return 'skipped';
      const waiting = repo.dependentsOf(task.id).map(d => repo.getTask(d.dependent_task_id)).filter(t => t && t.status !== 'done');
      if (!waiting.length) return 'skipped';
      await sender.channel(project.id, {
        content: `🔗 **Heads-up:** **${task.title}** (${mention(task.owner_id)}) is due ${ts(task.due_at, 'R')} and isn't marked in progress yet. ${waiting.map(t => `**${t!.title}** (${repo.memberName(project.id, t!.owner_id)})`).join(', ')} depend${waiting.length === 1 ? 's' : ''} on it.\n${repo.memberName(project.id, task.owner_id)}, are you on track?`,
        components: [overdueButtons(task.id)], allowedMentions: { users: task.owner_id ? [task.owner_id] : [] },
      });
      return 'sent';
    }
    case 'overdue_check': {
      if (!task || !taskOpen || !task.due_at || task.due_at > nowMs) return 'skipped';
      repo.updateTask(task.id, { status: 'overdue' });
      await toPerson(sender, r, {
        content: `🕐 ${mention(task.owner_id)} **#${task.id} ${task.title}** hit its deadline (${ts(task.due_at, 'R')}). No stress — where's it at?`,
        components: [overdueButtons(task.id)],
      });
      // Tell the people who are now blocked, privately if they prefer DMs.
      for (const d of repo.dependentsOf(task.id)) {
        const t = repo.getTask(d.dependent_task_id);
        if (!t?.owner_id || t.status === 'done') continue;
        const m = repo.getMember(project.id, t.owner_id);
        const msg = { content: `🚧 ${mention(t.owner_id)} heads-up: **${t.title}** depends on **${task.title}**, which is past due. I've asked ${repo.memberName(project.id, task.owner_id)} for an update and will tell you the moment it's done.` };
        if (m?.dm_reminders && await sender.dm(t.owner_id, msg)) continue;
        await sender.channel(project.id, { ...msg, allowedMentions: { users: [t.owner_id] } });
      }
      return 'sent';
    }
    case 'submission_check': {
      if (project.submitted_at) return 'skipped';
      const rd = readiness(project);
      const lines = [`📦 **${r.message} until the final deadline** (${ts(project.final_deadline, 'R')}).`];
      if (rd.unowned.length) lines.push(`❗ Nobody owns: ${rd.unowned.map(u => `**${u.req.title}**`).join(', ')}`);
      if (!project.submitter_id) lines.push('❗ No submitter chosen — pick one with `/submitter` so it doesn\'t fall through the cracks.');
      else lines.push(`${mention(project.submitter_id)} you're submitting — confirm with \`/submitted\` once it's actually turned in.`);
      await sender.channel(project.id, { content: lines.join('\n'), embeds: [readinessEmbed(project)], allowedMentions: { users: project.submitter_id ? [project.submitter_id] : [] } });
      return 'sent';
    }
    case 'submission_confirm': {
      if (project.submitted_at) return 'skipped';
      await sender.channel(project.id, {
        content: `🏁 The deadline just passed and I haven't seen a submission confirmation. ${project.submitter_id ? `${mention(project.submitter_id)}, did it go in? Run \`/submitted\` (a screenshot helps).` : 'Who submitted? They should run `/submitted`.'}`,
        allowedMentions: { users: project.submitter_id ? [project.submitter_id] : [] },
      });
      return 'sent';
    }
    case 'meeting_soon': {
      const m = r.meeting_id ? repo.getMeeting(r.meeting_id) : undefined;
      if (!m || m.status !== 'confirmed' || !m.confirmed_start || m.confirmed_start < nowMs) return 'skipped';
      const members = repo.listMembers(project.id).map(x => x.discord_id);
      await sender.channel(project.id, { content: `📅 **${m.title}** starts ${ts(m.confirmed_start, 'R')} (${ts(m.confirmed_start, 't')}). ${members.map(mention).join(' ')}`, allowedMentions: { users: members } });
      return 'sent';
    }
    case 'custom': {
      await toPerson(sender, r, { content: `🔔 ${mention(r.recipient_id)} reminder: ${r.message}` });
      return 'sent';
    }
    default:
      log.warn(`unknown reminder kind ${r.kind}`);
      return 'skipped';
  }
}

/** One scheduler pass. Exported for tests and for the /admin tick. */
export async function tick(sender: Sender, nowMs = Date.now()): Promise<{ sent: number; skipped: number }> {
  let sent = 0, skipped = 0;
  for (const r of repo.dueReminders(nowMs)) {
    try {
      (await fireReminder(sender, r, nowMs)) === 'sent' ? sent++ : skipped++;
      // Failed deliveries remain pending for the next pass. A crash after sending
      // but before this write can repeat a message (at-least-once delivery).
      repo.markReminderSent(r.id);
      repo.logAgent(r.project_id, 'Accountability Manager', `reminder:${r.kind}`, { id: r.id, task: r.task_id });
    } catch (e) {
      log.error(`reminder ${r.id} failed`, e);
    }
  }
  return { sent, skipped };
}

export function startScheduler(sender: Sender, intervalMs: number) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new Error('Scheduler interval must be at least one second');
  let stopped = false;
  let active: Promise<void> | undefined;
  let lastCompletedAt = 0;
  const run = async () => {
    try {
      const r = await tick(sender);
      lastCompletedAt = Date.now();
      if (r.sent || r.skipped) log.info(`scheduler: sent ${r.sent}, skipped ${r.skipped}`);
    } catch (e) { log.error('scheduler tick failed', e); }
  };
  const launch = () => {
    if (stopped || active) return;
    active = run().finally(() => { active = undefined; });
  };
  const timer = setInterval(launch, intervalMs);
  launch();
  return {
    healthy: () => !stopped && lastCompletedAt > 0 && Date.now() - lastCompletedAt < Math.max(120_000, intervalMs * 3),
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}

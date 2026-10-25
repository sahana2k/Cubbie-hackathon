import {
  ActionRowBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
  type AutocompleteInteraction, type ButtonInteraction, type ChatInputCommandInteraction, type Client,
  type Interaction, type ModalSubmitInteraction,
} from 'discord.js';
import { DateTime } from 'luxon';
import { config } from '../config';
import * as repo from '../db/repo';
import type { Project } from '../db/repo';
import * as actions from '../core/actions';
import { ActionError } from '../core/actions';
import { lockMeeting, startMeetingPoll } from '../core/meetings';
import { clockStr, parseClock, parseDays, parseWhen, ts, tsBoth, WEEKDAY_NAMES } from '../core/time';
import { log } from '../core/log';
import { agentEmoji, orchestrate } from '../agents/orchestrator';
import { attachmentToBlocks, displayName, projectForChannel } from './context';
import { deliverOuts, refreshDecisionCard } from './deliver';
import { COLORS, decisionMessage, meetingPollMessage, readinessEmbed, statusEmbed, taskLine } from './render';

const EPHEMERAL = MessageFlags.Ephemeral;

export async function handleInteraction(client: Client, i: Interaction) {
  try {
    if (i.isAutocomplete()) return await autocomplete(i);
    if (i.isChatInputCommand()) return await slash(client, i);
    if (i.isButton()) return await button(client, i);
    if (i.isModalSubmit()) return await modal(client, i);
  } catch (e) {
    const msg = e instanceof ActionError ? e.message : 'Something went wrong on my side. Try again in a moment.';
    if (!(e instanceof ActionError)) log.error('interaction failed', e);
    if (i.isRepliable()) {
      if (i.deferred && !i.replied) await i.editReply({ content: `⚠️ ${msg}` }).catch(() => null);
      else if (i.replied) await i.followUp({ content: `⚠️ ${msg}`, flags: EPHEMERAL }).catch(() => null);
      else await i.reply({ content: `⚠️ ${msg}`, flags: EPHEMERAL }).catch(() => null);
    }
  }
}

function requireProject(i: { channel: any }): Project {
  const p = projectForChannel(i.channel);
  if (!p) throw new ActionError('This channel isn\'t a Tesseract project yet. Run `/setup` here first.');
  return p;
}
function touchMember(p: Project, i: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction) {
  return repo.upsertMember(p.id, i.user.id, displayName(i.user, i.member));
}

// ─── Slash commands ──────────────────────────────────────
async function slash(client: Client, i: ChatInputCommandInteraction) {
  if (i.commandName === 'setup') return setup(client, i);
  if (i.commandName === 'help') return i.reply({ embeds: [helpEmbed()], flags: EPHEMERAL });

  const project = requireProject(i);
  touchMember(project, i);

  switch (i.commandName) {
    case 'join': {
      const n = repo.listMembers(project.id).length;
      return i.reply({ content: `👋 ${i.user} joined **${project.name}** (${n} member${n === 1 ? '' : 's'}). Tip: add your class times with \`/classes add\` so I never suggest meetings during class.` });
    }
    case 'status': return i.reply({ embeds: [statusEmbed(project)], allowedMentions: { parse: [] } });
    case 'readiness': return i.reply({ embeds: [readinessEmbed(project)], allowedMentions: { parse: [] } });
    case 'tasks': {
      const tasks = repo.listTasks(project.id).filter(t => t.status !== 'declined');
      const byOwner = new Map<string, repo.Task[]>();
      for (const t of tasks) { const k = t.owner_id ?? 'none'; byOwner.set(k, [...(byOwner.get(k) ?? []), t]); }
      const e = new EmbedBuilder().setColor(COLORS.brand).setTitle(`📋 ${project.name} — tasks`);
      if (!tasks.length) e.setDescription('No tasks yet. Upload a rubric with `/rubric`, or just tell me who\'s doing what.');
      for (const [owner, ts_] of byOwner) e.addFields({ name: owner === 'none' ? 'Unclaimed' : repo.memberName(project.id, owner), value: ts_.map(t => taskLine(t, false)).join('\n').slice(0, 1024) });
      return i.reply({ embeds: [e], allowedMentions: { parse: [] } });
    }
    case 'mytasks': {
      const tasks = repo.listTasks(project.id, { ownerId: i.user.id }).filter(t => t.status !== 'declined');
      const pending = repo.listDecisions(project.id, 'pending').filter(d => d.required_approvers.includes(i.user.id) && !d.approvals.includes(i.user.id));
      const e = new EmbedBuilder().setColor(COLORS.brand).setTitle('Your tasks')
        .setDescription(tasks.length ? tasks.map(t => taskLine(t, false)).join('\n') : 'Nothing on your plate. 🎈');
      if (pending.length) e.addFields({ name: 'Waiting for your answer', value: pending.map(d => `D${d.id}: ${d.summary.split('\n')[0]}`).join('\n').slice(0, 1024) });
      return i.reply({ embeds: [e], flags: EPHEMERAL });
    }
    case 'blocked': {
      const deps = repo.listDependencies(project.id, 'active');
      const lines = deps.map(d => ({ b: repo.getTask(d.blocking_task_id)!, w: repo.getTask(d.dependent_task_id)! }))
        .filter(x => x.b && x.w && x.b.status !== 'done' && x.w.status !== 'done')
        .map(x => `🚧 **${x.w.title}** (${repo.memberName(project.id, x.w.owner_id)}) is waiting on **${x.b.title}** (${repo.memberName(project.id, x.b.owner_id)}, due ${ts(x.b.due_at, 'R')})`);
      return i.reply({ content: lines.length ? lines.join('\n') : 'Nothing is blocked right now. ✨', allowedMentions: { parse: [] } });
    }
    case 'task': {
      const owner = i.options.getUser('owner');
      const dueText = i.options.getString('due');
      const due = dueText ? parseWhen(dueText, project.timezone) : null;
      if (dueText && due == null) throw new ActionError(`I couldn't read "${dueText}" as a date. Try "Wednesday 6pm" or "Nov 12 11:59pm".`);
      if (owner) repo.upsertMember(project.id, owner.id, owner.globalName ?? owner.username);
      const r = actions.proposeTask(project, {
        title: i.options.getString('title', true), description: i.options.getString('description'), owner_id: owner?.id ?? null, due_at: due,
        proposedBy: i.user.id, selfConsent: owner?.id === i.user.id,
      }, i.channelId);
      await i.reply({ content: `Created **#${r.task.id} ${r.task.title}**.${r.conflicts.length ? `\n⚠️ ${r.conflicts.join('\n⚠️ ')}` : ''}`, flags: EPHEMERAL });
      return deliverOuts(client, r.outs, i.channelId);
    }
    case 'claim': {
      const outs = actions.claimTask(project, i.options.getInteger('task', true), i.user.id);
      await i.reply({ content: '🙋 Claimed!', flags: EPHEMERAL });
      return deliverOuts(client, outs, i.channelId);
    }
    case 'done': {
      const outs = actions.completeTask(project, i.options.getInteger('task', true), i.user.id);
      await i.reply({ content: 'Marked done — nice. 🎉', flags: EPHEMERAL });
      return deliverOuts(client, outs, i.channelId);
    }
    case 'deadline': {
      const text = i.options.getString('due', true);
      const due = parseWhen(text, project.timezone);
      if (due == null) throw new ActionError(`I couldn't read "${text}" as a date.`);
      const r = actions.setDeadlineDirect(project, i.options.getInteger('task', true), due, i.user.id);
      await i.reply({ content: r.outs.some(o => o.kind === 'decision') ? 'Teammates depend on this task, so I\'ve asked them to approve the change.' : `Deadline set to ${tsBoth(due)}.`, flags: EPHEMERAL });
      return deliverOuts(client, r.outs, i.channelId);
    }
    case 'depends': {
      const r = actions.addDependencyAction(project, i.options.getInteger('needs', true), i.options.getInteger('task', true), i.options.getString('note'), i.user.id);
      await i.reply({ content: 'Dependency saved.', flags: EPHEMERAL });
      return deliverOuts(client, r.outs, i.channelId);
    }
    case 'meet': {
      const r = startMeetingPoll(project, {
        title: i.options.getString('title', true), durationMin: i.options.getInteger('minutes') ?? 60, daysAhead: i.options.getInteger('days') ?? 5,
        earliestHour: i.options.getInteger('earliest') ?? undefined, latestHour: i.options.getInteger('latest') ?? undefined, createdBy: i.user.id, channelId: i.channelId,
      });
      const noSchedules = repo.listMembers(project.id).filter(m => !repo.listBusyBlocks(project.id, m.discord_id).length);
      await i.reply({ content: `🔎 I checked everyone's class schedules and found the best slots.${noSchedules.length ? `\n(${noSchedules.map(m => m.display_name).join(', ')} haven't added classes yet — \`/classes add\` makes this smarter.)` : ''}`, allowedMentions: { parse: [] } });
      return deliverOuts(client, r.outs, i.channelId);
    }
    case 'classes': return classes(i, project);
    case 'rescue': {
      await i.deferReply();
      const res = await orchestrate({ project, actorId: i.user.id, actorName: displayName(i.user, i.member), channelId: i.channelId, mode: 'command',
        text: 'RESCUE MODE: We are behind. Review status, identify overdue/blocked work and its ripple effects, and propose concrete recovery moves (deadline changes or reassignments to people with capacity). Summarise the plan.',
        forceAgents: ['Dependency Manager', 'Accountability Manager'] });
      await i.editReply({ content: res.reply || 'I looked at the plan — nothing needs rescuing right now. 🙌', allowedMentions: { parse: ['users'] } });
      return deliverOuts(client, res.outs, i.channelId);
    }
    case 'rubric': {
      await i.deferReply();
      const blocks = await attachmentToBlocks(i.options.getAttachment('file', true));
      return ingestRubric(client, i, project, blocks);
    }
    case 'submitter': {
      const u = i.options.getUser('user', true);
      repo.upsertMember(project.id, u.id, u.globalName ?? u.username);
      repo.updateProject(project.id, { submitter_id: u.id });
      return i.reply({ content: `📮 ${u} is the designated submitter. I'll check in with them before the deadline and only count the project as submitted when they confirm with \`/submitted\`.` });
    }
    case 'submitted': {
      if (!project.submitter_id) repo.updateProject(project.id, { submitter_id: i.user.id });
      const p = repo.getProject(project.id)!;
      if (p.submitter_id !== i.user.id) throw new ActionError(`Only the designated submitter (${repo.memberName(p.id, p.submitter_id)}) can confirm submission.`);
      const shot = i.options.getAttachment('screenshot');
      const proof = [i.options.getString('proof'), shot?.url].filter(Boolean).join(' · ') || null;
      const missing = actions.readiness(p).missing;
      const d = repo.createDecision({ project_id: p.id, kind: 'confirm_submission', payload: { proof }, proposed_by: i.user.id, channel_id: i.channelId,
        summary: `${i.user}, confirm the project is **actually submitted** (not just ready)?${proof ? `\nProof: ${proof}` : ''}`,
        required_approvers: [i.user.id], conflicts: missing.map(m => `Rubric item "${m.req.title}" isn't marked done.`) });
      await i.reply({ content: 'One last check:', flags: EPHEMERAL });
      return deliverOuts(client, [{ kind: 'decision', decisionId: d.id }], i.channelId);
    }
    case 'settings': {
      const rem = i.options.getString('reminders') as repo.Member['reminder_pref'] | null;
      const dmPref = i.options.getBoolean('dm');
      const listen = i.options.getBoolean('listen');
      if (rem) repo.updateMember(project.id, i.user.id, { reminder_pref: rem });
      if (dmPref !== null) repo.updateMember(project.id, i.user.id, { dm_reminders: dmPref ? 1 : 0 });
      if (listen !== null) repo.updateProject(project.id, { passive_mode: listen ? 1 : 0 });
      // re-plan this member's open task reminders with the new preference
      if (rem || dmPref !== null) for (const t of repo.listTasks(project.id, { ownerId: i.user.id, statuses: repo.OPEN_STATUSES })) { repo.cancelTaskReminders(t.id); actions.scheduleTaskReminders(t); }
      const m = repo.getMember(project.id, i.user.id)!;
      const p = repo.getProject(project.id)!;
      return i.reply({ content: `⚙️ Reminders: **${m.reminder_pref}** · via **${m.dm_reminders ? 'DM' : 'channel'}** · listening to chat: **${p.passive_mode ? 'on' : 'off (only when tagged)'}**`, flags: EPHEMERAL });
    }
    case 'ask': {
      await i.deferReply();
      const q = i.options.getString('question', true);
      repo.logChat(project.id, i.user.id, displayName(i.user, i.member), q);
      const res = await orchestrate({ project, actorId: i.user.id, actorName: displayName(i.user, i.member), channelId: i.channelId, text: q, mode: 'mention' });
      await i.editReply({ content: `> ${q.slice(0, 200)}\n${res.reply || 'Done — see below.'}`, allowedMentions: { parse: ['users'] } });
      return deliverOuts(client, res.outs, i.channelId);
    }
    case 'agents': {
      const rows = repo.recentAgentLog(project.id, 20);
      const e = new EmbedBuilder().setColor(COLORS.info).setTitle('🧭 Agent activity (most recent first)')
        .setDescription(rows.map(r => `${agentEmoji(r.agent)} \`${DateTime.fromMillis(r.created_at, { zone: project.timezone }).toFormat('ccc HH:mm')}\` **${r.agent}** ${r.action}${r.detail ? ` — ${r.detail.slice(0, 90)}` : ''}`).join('\n').slice(0, 4000) || 'No activity yet.');
      return i.reply({ embeds: [e], flags: EPHEMERAL });
    }
  }
}

async function setup(client: Client, i: ChatInputCommandInteraction) {
  // Acknowledge before parsing dates or touching SQLite; Discord allows only 3s.
  await i.deferReply();
  if (!i.guildId) throw new ActionError('Run /setup inside a server channel.');
  const tz = i.options.getString('timezone') || config.defaultTimezone;
  if (!DateTime.local().setZone(tz).isValid) throw new ActionError(`Unknown timezone "${tz}". Use an IANA name like America/Phoenix.`);
  const deadlineText = i.options.getString('deadline', true);
  const deadline = parseWhen(deadlineText, tz);
  if (deadline == null) throw new ActionError(`I couldn't read "${deadlineText}" as a date. Try "Dec 5 11:59pm".`);
  const rubric = i.options.getAttachment('rubric');
  const submitter = i.options.getUser('submitter');

  let project = repo.getProjectByChannel(i.channelId);
  if (project) repo.updateProject(project.id, { name: i.options.getString('name', true), course: i.options.getString('course'), final_deadline: deadline, timezone: tz });
  else project = repo.createProject({ guild_id: i.guildId, channel_id: i.channelId, name: i.options.getString('name', true), course: i.options.getString('course'), final_deadline: deadline, timezone: tz, created_by: i.user.id });
  project = repo.getProject(project.id)!;
  touchMember(project, i);
  if (submitter) { repo.upsertMember(project.id, submitter.id, submitter.globalName ?? submitter.username); repo.updateProject(project.id, { submitter_id: submitter.id }); }
  actions.scheduleSubmissionGuards(repo.getProject(project.id)!);
  repo.logAgent(project.id, 'system', 'project_setup', { name: project.name, deadline });

  const welcome = new EmbedBuilder().setColor(COLORS.brand).setTitle(`🚀 ${project.name} is set up`)
    .setDescription([
      `**Final deadline:** ${tsBoth(deadline)}`,
      submitter ? `**Submitter:** ${submitter}` : '**Submitter:** not chosen yet — `/submitter`',
      '',
      '**Everyone:** run `/join`, then `/classes add` with your class times (kept private).',
      '**Then just talk normally.** "I\'ll do the slides", "I need Alex\'s research first", "can we meet Thursday?" — I\'ll pick it up and ask before recording anything.',
      'Tag me (@Tesseract) with any question. `/status` any time.',
    ].join('\n'));
  if (!rubric) {
    welcome.addFields({ name: 'Got a rubric?', value: 'Upload it with `/rubric` and I\'ll turn it into a claim board of deliverables.' });
    return i.editReply({ embeds: [welcome] });
  }
  await i.editReply({ embeds: [welcome] });
  const blocks = await attachmentToBlocks(rubric);
  return ingestRubric(client, i, repo.getProject(project.id)!, blocks, true);
}

async function ingestRubric(client: Client, i: ChatInputCommandInteraction, project: Project, blocks: any[], followUp = false) {
  const res = await orchestrate({
    project, actorId: i.user.id, actorName: displayName(i.user, i.member), channelId: i.channelId, mode: 'command', attachments: blocks, forceAgents: ['Planner'],
    text: 'This is our assignment rubric. Record every graded requirement with set_requirements (include the final deadline and submission instructions if stated), then propose one unowned task per deliverable with milestone due dates before the final deadline. Then give a 2-3 line summary of what the professor wants.',
  });
  const content = `📄 **Rubric read.**\n${res.reply || 'Requirements recorded.'}`;
  if (followUp) await i.followUp({ content });
  else await i.editReply({ content });
  await deliverOuts(client, res.outs, i.channelId);
}

async function classes(i: ChatInputCommandInteraction, project: Project) {
  const sub = i.options.getSubcommand();
  if (sub === 'clear') { repo.clearBusyBlocks(project.id, i.user.id); return i.reply({ content: 'Cleared your schedule.', flags: EPHEMERAL }); }
  if (sub === 'list') {
    const blocks = repo.listBusyBlocks(project.id, i.user.id);
    return i.reply({ content: blocks.length ? blocks.map(b => `• ${WEEKDAY_NAMES[b.weekday]} ${clockStr(b.start_min)}–${clockStr(b.end_min)}${b.label ? ` (${b.label})` : ''}`).join('\n') : 'No schedule saved. Add with `/classes add`.', flags: EPHEMERAL });
  }
  const days = parseDays(i.options.getString('days', true));
  const s = parseClock(i.options.getString('start', true)), e = parseClock(i.options.getString('end', true));
  if (!days.length || s == null || e == null || e <= s) throw new ActionError('Couldn\'t read that. Example: days `TTh`, start `1:30pm`, end `2:45pm`.');
  for (const d of days) repo.addBusyBlock({ project_id: project.id, discord_id: i.user.id, weekday: d, start_min: s, end_min: e, label: i.options.getString('label') });
  return i.reply({ content: `📚 Saved ${days.map(d => WEEKDAY_NAMES[d]).join('/')} ${clockStr(s)}–${clockStr(e)}. Only you can see the label — teammates only see that you're busy.`, flags: EPHEMERAL });
}

// ─── Buttons ─────────────────────────────────────────────
async function button(client: Client, i: ButtonInteraction) {
  const [kind, a, b] = i.customId.split(':');
  const project = requireProject(i);
  touchMember(project, i);

  if (kind === 'dec') {
    const r = actions.voteOnDecision(Number(a), i.user.id, b === 'y');
    await i.update(decisionMessage(r.decision) as any);
    if (!r.resolved) await i.followUp({ content: 'Got it — waiting on the others.', flags: EPHEMERAL });
    return deliverOuts(client, r.outs, i.channelId);
  }
  if (kind === 'claim') {
    const outs = actions.claimTask(project, Number(a), i.user.id);
    await i.reply({ content: `🙋 You've got **#${a}**. Set a deadline any time with \`/deadline\`.`, flags: EPHEMERAL });
    const board = i.message;
    // remove the claimed button from the board
    const rows = board.components.map((row: any) => {
      const kept = row.components.filter((c: any) => c.customId !== i.customId);
      return kept.length ? { type: 1, components: kept.map((c: any) => c.toJSON()) } : null;
    }).filter(Boolean);
    await board.edit({ components: rows as any }).catch(() => null);
    return deliverOuts(client, outs, i.channelId);
  }
  if (kind === 'mvote') {
    const m = repo.getMeeting(Number(a));
    if (!m || m.status === 'confirmed') throw new ActionError('That poll is closed.');
    repo.toggleVote(m.id, Number(b), i.user.id);
    return i.update(meetingPollMessage(m.id) as any);
  }
  if (kind === 'mlock') {
    const outs = lockMeeting(project, Number(a), null, i.user.id);
    await i.update(meetingPollMessage(Number(a)) as any);
    return deliverOuts(client, outs, i.channelId);
  }
  if (kind === 'od') {
    const task = repo.getTask(Number(a));
    if (!task) throw new ActionError('Task not found.');
    if (task.owner_id && task.owner_id !== i.user.id) throw new ActionError('Only the task owner can answer this check-in.');
    if (b === 'done') {
      const outs = actions.completeTask(project, task.id, i.user.id);
      await i.update({ components: [] });
      return deliverOuts(client, outs, i.channelId);
    }
    if (b === 'time') {
      const modalB = new ModalBuilder().setCustomId(`odtime:${task.id}`).setTitle(`New deadline for #${task.id}`)
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('due').setLabel('When can you have it done?').setPlaceholder('e.g. tomorrow 6pm').setStyle(TextInputStyle.Short).setRequired(true)));
      return i.showModal(modalB);
    }
    if (b === 'help') {
      await i.update({ components: [] });
      const res = await orchestrate({ project, actorId: i.user.id, actorName: displayName(i.user, i.member), channelId: i.channelId, mode: 'command', forceAgents: ['Dependency Manager'],
        text: `I need help finishing task #${task.id} "${task.title}" (status ${task.status}, due ${task.due_at ? new Date(task.due_at).toISOString() : 'none'}). Figure out who is affected and propose the best fix — usually a reassignment of part/all of it to the teammate with the most capacity, or a deadline change if the ripple fits.` });
      if (res.reply) await i.followUp({ content: res.reply, allowedMentions: { parse: ['users'] } });
      return deliverOuts(client, res.outs, i.channelId);
    }
  }
}

async function modal(client: Client, i: ModalSubmitInteraction) {
  const [kind, a] = i.customId.split(':');
  const project = requireProject(i);
  if (kind === 'odtime') {
    const text = i.fields.getTextInputValue('due');
    const due = parseWhen(text, project.timezone);
    if (due == null) throw new ActionError(`I couldn't read "${text}" as a date.`);
    const task = repo.getTask(Number(a))!;
    const r = task.owner_id === i.user.id ? actions.setDeadlineDirect(project, task.id, due, i.user.id) : actions.proposeDeadlineChange(project, task.id, due, 'Needs more time', i.user.id);
    await i.reply({ content: `🕐 Thanks for the heads-up. New target: ${tsBoth(due)}${r.outs.some(o => o.kind === 'decision') ? ' — teammates who depend on it need to OK it.' : '.'}` });
    return deliverOuts(client, r.outs, i.channelId ?? undefined);
  }
}

// ─── Autocomplete ────────────────────────────────────────
async function autocomplete(i: AutocompleteInteraction) {
  const project = projectForChannel(i.channel);
  if (!project) return i.respond([]);
  const focused = String(i.options.getFocused()).toLowerCase();
  let tasks = repo.listTasks(project.id).filter(t => t.status !== 'declined' || i.commandName === 'claim');
  if (i.commandName === 'claim') tasks = tasks.filter(t => !t.owner_id || ['declined', 'proposed'].includes(t.status));
  if (i.commandName === 'done' || i.commandName === 'deadline') tasks = tasks.filter(t => t.owner_id === i.user.id && t.status !== 'done');
  tasks = tasks.filter(t => !focused || t.title.toLowerCase().includes(focused) || String(t.id).startsWith(focused)).slice(0, 25);
  return i.respond(tasks.map(t => ({ name: `#${t.id} ${t.title} (${t.owner_id ? repo.memberName(project.id, t.owner_id) : 'open'}, ${t.status})`.slice(0, 100), value: t.id })));
}

export function helpEmbed() {
  return new EmbedBuilder().setColor(COLORS.brand).setTitle('Tesseract — your group project\'s project manager')
    .setDescription('Nobody has to be the PM. Talk normally; I turn chat into a plan and **always ask before committing anyone to anything**.')
    .addFields(
      { name: 'Get started', value: '`/setup` (name, deadline, rubric) → everyone `/join` → `/classes add` your class times' },
      { name: 'Talk to me', value: 'Tag **@Tesseract** with anything: "who\'s doing the report?", "I can\'t finish research by Wed", "find us a time to meet", "remind me Thu 5pm to submit peer review", or general questions.' },
      { name: 'Tasks', value: '`/task` `/claim` `/done` `/deadline` `/depends` `/tasks` `/mytasks` `/blocked`' },
      { name: 'Meetings', value: '`/meet` finds slots around everyone\'s classes, then vote & lock in. You get a calendar invite.' },
      { name: 'Staying on track', value: '`/status` `/rescue` `/readiness` `/submitter` `/submitted`' },
      { name: 'Privacy & control', value: '`/settings` reminder frequency, DM reminders, and whether I listen to chat without being tagged. `/agents` shows exactly what the AI did.' },
    );
}

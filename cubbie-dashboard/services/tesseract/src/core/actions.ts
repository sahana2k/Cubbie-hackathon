import * as repo from '../db/repo';
import { OPEN_STATUSES, type Decision, type Project, type Task } from '../db/repo';
import { checkDependency, checkTaskPlacement, deadlineRipple } from './constraints';
import { HOUR, MINUTE, localStr, tsBoth } from './time';

/**
 * Domain actions. Everything that changes project state goes through here, whether it
 * was triggered by a slash command, a button, an agent tool call, or the scheduler.
 * Actions never talk to Discord directly; they return an Outbox the Discord layer delivers.
 */
export type Out =
  | { kind: 'text'; projectId: number; text: string; dmUserId?: string }
  | { kind: 'decision'; decisionId: number }
  | { kind: 'meeting_confirmed'; meetingId: number }
  | { kind: 'meeting_poll'; meetingId: number }
  | { kind: 'claim_board'; projectId: number; taskIds: number[] };

export class ActionError extends Error {}

const mention = (id: string | null | undefined) => (id ? `<@${id}>` : '*unassigned*');

// ─── Reminder planning ───────────────────────────────────
const REMINDER_OFFSETS: Record<repo.Member['reminder_pref'], number[]> = {
  minimal: [3 * HOUR],
  normal: [24 * HOUR, 3 * HOUR],
  frequent: [48 * HOUR, 24 * HOUR, 3 * HOUR, 1 * HOUR],
};

export function scheduleTaskReminders(task: Task, nowMs = Date.now()): number {
  if (!task.due_at || !task.owner_id) return 0;
  const member = repo.getMember(task.project_id, task.owner_id);
  const pref = member?.reminder_pref ?? 'normal';
  const isPrivate = !!member?.dm_reminders;
  let n = 0;
  for (const off of REMINDER_OFFSETS[pref]) {
    const at = task.due_at - off;
    if (at <= nowMs) continue;
    if (repo.scheduleReminder({ project_id: task.project_id, recipient_id: task.owner_id, task_id: task.id, kind: 'task_due_soon',
      message: `${off / HOUR}h`, trigger_at: at, private: isPrivate, dedupe_key: `task:${task.id}:due:${task.due_at}:${off}` })) n++;
  }
  // Dependency-aware early warning: 24h before a blocker's deadline, check it's on track.
  if (repo.dependentsOf(task.id).length && task.due_at - 24 * HOUR > nowMs) {
    repo.scheduleReminder({ project_id: task.project_id, task_id: task.id, kind: 'dependency_risk', message: '',
      trigger_at: task.due_at - 24 * HOUR, dedupe_key: `task:${task.id}:deprisk:${task.due_at}` });
  }
  repo.scheduleReminder({ project_id: task.project_id, recipient_id: task.owner_id, task_id: task.id, kind: 'overdue_check', message: '',
    trigger_at: task.due_at + 5 * MINUTE, private: isPrivate, dedupe_key: `task:${task.id}:overdue:${task.due_at}` });
  return n;
}

export function scheduleSubmissionGuards(project: Project, nowMs = Date.now()) {
  if (!project.final_deadline) return;
  for (const off of [48 * HOUR, 24 * HOUR, 3 * HOUR]) {
    const at = project.final_deadline - off;
    if (at > nowMs) repo.scheduleReminder({ project_id: project.id, kind: 'submission_check', message: `${off / HOUR}h`, trigger_at: at,
      dedupe_key: `project:${project.id}:subcheck:${project.final_deadline}:${off}` });
  }
  repo.scheduleReminder({ project_id: project.id, kind: 'submission_confirm', message: '', trigger_at: project.final_deadline + 15 * MINUTE,
    dedupe_key: `project:${project.id}:subconfirm:${project.final_deadline}` });
}

// ─── Tasks ───────────────────────────────────────────────
export interface ProposeTaskInput {
  title: string; description?: string | null; owner_id?: string | null; due_at?: number | null;
  requirement_id?: number | null; source_url?: string | null; proposedBy: string;
  /** true when the owner themself is the one creating it (claim button, /task add for self) */
  selfConsent?: boolean;
}

export function proposeTask(project: Project, input: ProposeTaskInput, channelId?: string | null): { task: Task; decision?: Decision; conflicts: string[]; outs: Out[] } {
  const conflicts = checkTaskPlacement(project, { owner_id: input.owner_id, due_at: input.due_at });
  const task = repo.createTask({ project_id: project.id, title: input.title, description: input.description, owner_id: input.owner_id ?? null,
    due_at: input.due_at ?? null, requirement_id: input.requirement_id ?? null, source_url: input.source_url, created_by: input.proposedBy, status: 'proposed' });

  if (input.owner_id && input.selfConsent) {
    const outs = confirmTask(task.id);
    return { task: repo.getTask(task.id)!, conflicts, outs };
  }
  if (!input.owner_id) {
    return { task, conflicts, outs: [{ kind: 'claim_board', projectId: project.id, taskIds: [task.id] }] };
  }
  const decision = repo.createDecision({
    project_id: project.id, kind: 'assign_task', payload: { task_id: task.id }, proposed_by: input.proposedBy, channel_id: channelId ?? project.channel_id,
    summary: `${mention(input.owner_id)}, can you own **${task.title}**${task.due_at ? ` — due ${tsBoth(task.due_at)}` : ''}?`,
    required_approvers: [input.owner_id], conflicts,
  });
  return { task, decision, conflicts, outs: [{ kind: 'decision', decisionId: decision.id }] };
}

export function confirmTask(taskId: number): Out[] {
  const task = repo.getTask(taskId);
  if (!task) throw new ActionError(`Task #${taskId} not found`);
  const blocked = repo.blockersOf(taskId).some(d => repo.getTask(d.blocking_task_id)?.status !== 'done');
  repo.updateTask(taskId, { status: blocked ? 'blocked' : 'confirmed' });
  scheduleTaskReminders(repo.getTask(taskId)!);
  repo.logAgent(task.project_id, 'system', 'task_confirmed', { task_id: taskId, owner: task.owner_id });
  const project = repo.getProject(task.project_id)!;
  const dueTxt = task.due_at ? ` — due ${tsBoth(task.due_at)}` : '';
  const reminderTxt = task.due_at ? ` I'll remind ${repo.memberName(project.id, task.owner_id)} before it's due.` : ' No deadline yet — set one with `/deadline`.';
  return [{ kind: 'text', projectId: task.project_id, text: `✅ **#${task.id} ${task.title}** is confirmed for ${mention(task.owner_id)}${dueTxt}.${reminderTxt}` }];
}

export function declineTask(taskId: number, by: string): Out[] {
  const task = repo.getTask(taskId);
  if (!task) throw new ActionError(`Task #${taskId} not found`);
  repo.updateTask(taskId, { status: 'declined', owner_id: null });
  repo.cancelTaskReminders(taskId);
  return [{ kind: 'text', projectId: task.project_id, text: `↩️ ${mention(by)} passed on **#${task.id} ${task.title}**. It's open — anyone can grab it with \`/claim task:${task.id}\`.` }];
}

export function claimTask(project: Project, taskId: number, userId: string): Out[] {
  const task = repo.getTask(taskId);
  if (!task || task.project_id !== project.id) throw new ActionError(`Task #${taskId} isn't in this project.`);
  if (task.status === 'done') throw new ActionError(`#${taskId} is already done.`);
  if (task.owner_id && task.owner_id !== userId && !['declined', 'proposed'].includes(task.status))
    throw new ActionError(`#${taskId} is owned by ${repo.memberName(project.id, task.owner_id)}. Ask them, or ask me to propose a reassignment.`);
  repo.updateTask(taskId, { owner_id: userId });
  // Close any pending assignment decision for this task — the claimer has consented.
  for (const d of repo.listDecisions(project.id, 'pending')) if (d.kind === 'assign_task' && d.payload.task_id === taskId) repo.updateDecision(d.id, { status: 'expired', resolved_at: Date.now() });
  return confirmTask(taskId);
}

export function setDeadlineDirect(project: Project, taskId: number, dueAt: number, by: string): { outs: Out[]; conflicts: string[] } {
  const task = repo.getTask(taskId);
  if (!task || task.project_id !== project.id) throw new ActionError(`Task #${taskId} isn't in this project.`);
  if (task.owner_id && task.owner_id !== by) throw new ActionError(`Only the owner can set this directly — I can propose a deadline change instead.`);
  const { conflicts, affectedOwners } = deadlineRipple(project, task, dueAt);
  if (affectedOwners.length && task.due_at) {
    // Teammates depend on this — moving it needs their OK.
    return proposeDeadlineChange(project, taskId, dueAt, 'Owner updated the deadline', by);
  }
  repo.cancelTaskReminders(taskId);
  repo.updateTask(taskId, { due_at: dueAt });
  if (task.status !== 'proposed') scheduleTaskReminders(repo.getTask(taskId)!);
  const warn = conflicts.length ? `\n⚠️ ${conflicts.join('\n⚠️ ')}` : '';
  return { conflicts, outs: [{ kind: 'text', projectId: project.id, text: `🗓️ **#${task.id} ${task.title}** is now due ${tsBoth(dueAt)}.${warn}` }] };
}

export function completeTask(project: Project, taskId: number, by: string): Out[] {
  const task = repo.getTask(taskId);
  if (!task || task.project_id !== project.id) throw new ActionError(`Task #${taskId} isn't in this project.`);
  if (task.owner_id && task.owner_id !== by) throw new ActionError(`Only ${repo.memberName(project.id, task.owner_id)} can mark #${taskId} done.`);
  if (task.status === 'done') throw new ActionError(`#${taskId} is already done.`);
  repo.updateTask(taskId, { status: 'done', owner_id: task.owner_id ?? by });
  repo.cancelTaskReminders(taskId);
  const unblocked: string[] = [];
  for (const dep of repo.dependentsOf(taskId)) {
    const d = repo.getTask(dep.dependent_task_id);
    if (!d) continue;
    const stillBlocked = repo.blockersOf(d.id).some(b => b.blocking_task_id !== taskId && repo.getTask(b.blocking_task_id)?.status !== 'done');
    if (!stillBlocked && d.status === 'blocked') repo.updateTask(d.id, { status: 'confirmed' });
    if (!stillBlocked && d.owner_id) unblocked.push(`${mention(d.owner_id)} — **${d.title}** is unblocked, you're good to go.`);
  }
  repo.resolveDependenciesFor(taskId);
  repo.logAgent(project.id, 'system', 'task_done', { task_id: taskId, by });
  const outs: Out[] = [{ kind: 'text', projectId: project.id, text: `🎉 **#${task.id} ${task.title}** is done (${mention(task.owner_id ?? by)}).${unblocked.length ? '\n' + unblocked.join('\n') : ''}` }];
  const r = readiness(project);
  if (r.requirements.length && r.missing.length === 0 && !project.submitted_at)
    outs.push({ kind: 'text', projectId: project.id, text: `📦 Every rubric requirement now has a finished deliverable. ${project.submitter_id ? `${mention(project.submitter_id)}, you're the submitter — run \`/submitted\` once it's actually turned in.` : 'Pick a submitter with `/submitter`.'}` });
  return outs;
}

export function setTaskStatus(project: Project, taskId: number, status: 'in_progress' | 'blocked', by: string, note?: string): Out[] {
  const task = repo.getTask(taskId);
  if (!task || task.project_id !== project.id) throw new ActionError(`Task #${taskId} isn't in this project.`);
  if (task.owner_id && task.owner_id !== by) throw new ActionError(`Only the owner can update #${taskId}'s status.`);
  repo.updateTask(taskId, { status });
  return [{ kind: 'text', projectId: project.id, text: `${status === 'blocked' ? '🚧' : '🔨'} **#${task.id} ${task.title}** → ${status.replace('_', ' ')}${note ? ` — ${note}` : ''}` }];
}

export function addDependencyAction(project: Project, blockingId: number, dependentId: number, note: string | null, by: string): { outs: Out[]; conflicts: string[] } {
  const blocking = repo.getTask(blockingId), dependent = repo.getTask(dependentId);
  if (!blocking || !dependent || blocking.project_id !== project.id || dependent.project_id !== project.id) throw new ActionError('Both tasks must exist in this project.');
  const conflicts = checkDependency(project, blocking, dependent);
  if (conflicts.some(c => c.includes('circular'))) throw new ActionError(conflicts.find(c => c.includes('circular'))!);
  repo.addDependency(project.id, blockingId, dependentId, note);
  if (blocking.status !== 'done' && OPEN_STATUSES.includes(dependent.status)) repo.updateTask(dependentId, { status: 'blocked' });
  // Re-plan the blocker's reminders so the dependency-risk warning is included.
  if (OPEN_STATUSES.includes(blocking.status)) scheduleTaskReminders(blocking);
  repo.logAgent(project.id, 'Dependency Manager', 'dependency_added', { blockingId, dependentId, by, conflicts });
  const warn = conflicts.length ? `\n⚠️ ${conflicts.join('\n⚠️ ')}` : '';
  return {
    conflicts,
    outs: [{ kind: 'text', projectId: project.id, text: `🔗 Dependency noted: **${dependent.title}** (${mention(dependent.owner_id)}) needs **${blocking.title}** (${mention(blocking.owner_id)}) first.${blocking.status !== 'done' ? ` I'll tell ${repo.memberName(project.id, dependent.owner_id)} the moment it's marked done.` : ''}${warn}` }],
  };
}

// ─── Proposals that need consent ─────────────────────────
export function proposeReassignment(project: Project, taskId: number, toId: string, reason: string, proposedBy: string): { outs: Out[]; conflicts: string[] } {
  const task = repo.getTask(taskId);
  if (!task || task.project_id !== project.id) throw new ActionError(`Task #${taskId} isn't in this project.`);
  if (task.owner_id === toId) throw new ActionError(`${repo.memberName(project.id, toId)} already owns it.`);
  const conflicts = checkTaskPlacement(project, { taskId, owner_id: toId, due_at: task.due_at });
  const approvers = [toId, ...(task.owner_id && task.owner_id !== proposedBy ? [task.owner_id] : [])];
  const d = repo.createDecision({
    project_id: project.id, kind: 'reassign_task', payload: { task_id: taskId, from: task.owner_id, to: toId, reason }, proposed_by: proposedBy,
    summary: `Move **#${task.id} ${task.title}** from ${mention(task.owner_id)} to ${mention(toId)}?${reason ? `\n> ${reason}` : ''}`,
    required_approvers: approvers, conflicts,
  });
  return { conflicts, outs: [{ kind: 'decision', decisionId: d.id }] };
}

export function proposeDeadlineChange(project: Project, taskId: number, newDue: number, reason: string, proposedBy: string): { outs: Out[]; conflicts: string[] } {
  const task = repo.getTask(taskId);
  if (!task || task.project_id !== project.id) throw new ActionError(`Task #${taskId} isn't in this project.`);
  const { conflicts, affectedOwners } = deadlineRipple(project, task, newDue);
  const approvers = [...new Set([...(task.owner_id ? [task.owner_id] : []), ...affectedOwners])];
  if (!approvers.length) approvers.push(proposedBy);
  const d = repo.createDecision({
    project_id: project.id, kind: 'change_deadline', payload: { task_id: taskId, old_due: task.due_at, new_due: newDue, reason }, proposed_by: proposedBy,
    summary: `Move **#${task.id} ${task.title}** (${mention(task.owner_id)}) from ${tsBoth(task.due_at)} to **${tsBoth(newDue)}**?${reason ? `\n> ${reason}` : ''}${affectedOwners.length ? `\nAffects: ${affectedOwners.map(mention).join(', ')}` : ''}`,
    required_approvers: approvers, conflicts,
  });
  return { conflicts, outs: [{ kind: 'decision', decisionId: d.id }] };
}

// ─── Voting on decisions ─────────────────────────────────
export function voteOnDecision(decisionId: number, userId: string, approve: boolean): { decision: Decision; outs: Out[]; resolved: boolean } {
  const d = repo.getDecision(decisionId);
  if (!d) throw new ActionError('That proposal no longer exists.');
  if (d.status !== 'pending') throw new ActionError(`This proposal is already ${d.status}.`);
  if (!d.required_approvers.includes(userId)) throw new ActionError(`Only ${d.required_approvers.map(mention).join(', ')} can answer this one.`);

  const approvals = [...new Set(approve ? [...d.approvals, userId] : d.approvals.filter(a => a !== userId))];
  const rejections = [...new Set(!approve ? [...d.rejections, userId] : d.rejections.filter(a => a !== userId))];
  repo.updateDecision(d.id, { approvals, rejections });

  let outs: Out[] = [];
  let resolved = false;
  if (rejections.length) {
    repo.updateDecision(d.id, { status: 'rejected', resolved_at: Date.now() });
    outs = onRejected(d, userId);
    resolved = true;
  } else if (d.required_approvers.every(a => approvals.includes(a))) {
    repo.updateDecision(d.id, { status: 'approved', resolved_at: Date.now() });
    outs = applyDecision(d);
    resolved = true;
  }
  repo.logAgent(d.project_id, 'system', approve ? 'decision_approved_by' : 'decision_rejected_by', { decision: d.id, kind: d.kind, user: userId, resolved });
  return { decision: repo.getDecision(d.id)!, outs, resolved };
}

function applyDecision(d: Decision): Out[] {
  const project = repo.getProject(d.project_id)!;
  switch (d.kind) {
    case 'assign_task': return confirmTask(d.payload.task_id);
    case 'reassign_task': {
      const task = repo.getTask(d.payload.task_id)!;
      repo.cancelTaskReminders(task.id);
      const wasBlocked = repo.blockersOf(task.id).some(b => repo.getTask(b.blocking_task_id)?.status !== 'done');
      repo.updateTask(task.id, { owner_id: d.payload.to, status: wasBlocked ? 'blocked' : (task.due_at && task.due_at < Date.now() ? 'overdue' : 'confirmed') });
      scheduleTaskReminders(repo.getTask(task.id)!);
      return [{ kind: 'text', projectId: project.id, text: `🔁 **#${task.id} ${task.title}** now belongs to ${mention(d.payload.to)}. Thanks for stepping in! Reminders moved over.` }];
    }
    case 'change_deadline': {
      const task = repo.getTask(d.payload.task_id)!;
      repo.cancelTaskReminders(task.id);
      repo.updateTask(task.id, { due_at: d.payload.new_due, status: task.status === 'overdue' ? 'confirmed' : task.status });
      scheduleTaskReminders(repo.getTask(task.id)!);
      // Ripple: dependents whose deadlines are now too tight get flagged with a suggested fix.
      const squeezed: string[] = [];
      for (const dep of repo.dependentsOf(task.id)) {
        const t = repo.getTask(dep.dependent_task_id);
        if (t?.due_at && t.due_at < d.payload.new_due + 12 * HOUR) squeezed.push(`**${t.title}** (${mention(t.owner_id)}) is due ${tsBoth(t.due_at)} — want me to push it too? Just ask.`);
      }
      return [{ kind: 'text', projectId: project.id, text: `🗓️ Agreed — **#${task.id} ${task.title}** is now due ${tsBoth(d.payload.new_due)}.${squeezed.length ? '\n' + squeezed.join('\n') : ''}` }];
    }
    case 'confirm_meeting': {
      const m = repo.getMeeting(d.payload.meeting_id)!;
      const opt = m.options[d.payload.option_index];
      repo.updateMeeting(m.id, { status: 'confirmed', confirmed_start: opt.start });
      for (const off of [24 * HOUR, 1 * HOUR]) {
        if (opt.start - off > Date.now()) repo.scheduleReminder({ project_id: project.id, meeting_id: m.id, kind: 'meeting_soon', message: `${off / HOUR}h`,
          trigger_at: opt.start - off, dedupe_key: `meeting:${m.id}:${opt.start}:${off}` });
      }
      return [{ kind: 'meeting_confirmed', meetingId: m.id }];
    }
    case 'confirm_submission': {
      repo.updateProject(project.id, { submitted_at: Date.now(), submission_proof: d.payload.proof ?? null });
      return [{ kind: 'text', projectId: project.id, text: `🏁 Submission confirmed by ${mention(project.submitter_id)}${d.payload.proof ? ` — proof: ${d.payload.proof}` : ''}. Nice work, team. 🎓` }];
    }
  }
}

function onRejected(d: Decision, by: string): Out[] {
  const project = repo.getProject(d.project_id)!;
  switch (d.kind) {
    case 'assign_task': return declineTask(d.payload.task_id, by);
    case 'confirm_meeting': {
      const m = repo.getMeeting(d.payload.meeting_id)!;
      repo.updateMeeting(m.id, { status: 'collecting' });
      return [{ kind: 'text', projectId: project.id, text: `📅 ${mention(by)} can't make that time. The poll for **${m.title}** is still open — vote for other slots and lock in again.` }];
    }
    default:
      return [{ kind: 'text', projectId: project.id, text: `❌ ${mention(by)} declined: ${d.summary.split('\n')[0]}\nNothing changed. Mention me if you want to try a different plan.` }];
  }
}

// ─── Snapshots: status, readiness, state for agents ──────
export function readiness(project: Project) {
  const reqs = repo.listRequirements(project.id);
  const tasks = repo.listTasks(project.id);
  const rows = reqs.map(r => {
    const linked = tasks.filter(t => t.requirement_id === r.id && t.status !== 'declined');
    const done = linked.length > 0 && linked.every(t => t.status === 'done');
    const owned = linked.some(t => t.owner_id && t.status !== 'proposed');
    return { req: r, linked, state: done ? 'done' as const : owned ? 'in_progress' as const : 'missing' as const };
  });
  return { requirements: rows, missing: rows.filter(r => r.state !== 'done'), unowned: rows.filter(r => r.state === 'missing') };
}

export function projectStatus(project: Project, nowMs = Date.now()) {
  const tasks = repo.listTasks(project.id).filter(t => !['declined'].includes(t.status));
  const committed = tasks.filter(t => t.status !== 'proposed');
  const done = committed.filter(t => t.status === 'done');
  const attention: { task: Task; reason: string; rank: number }[] = [];
  for (const t of committed) {
    if (t.status === 'done') continue;
    if (t.status === 'overdue' || (t.due_at && t.due_at < nowMs)) attention.push({ task: t, reason: 'overdue', rank: 0 });
    else if (t.status === 'blocked') {
      const by = repo.blockersOf(t.id).map(b => repo.getTask(b.blocking_task_id)).filter(Boolean).map(b => b!.title);
      attention.push({ task: t, reason: `blocked by ${by.join(', ') || 'a teammate'}`, rank: 1 });
    } else if (t.due_at && t.due_at - nowMs < 24 * HOUR) attention.push({ task: t, reason: `due ${tsBoth(t.due_at)}`, rank: 2 });
    else attention.push({ task: t, reason: t.status === 'in_progress' ? 'in progress' : `due ${tsBoth(t.due_at)}`, rank: 3 });
  }
  attention.sort((a, b) => a.rank - b.rank || (a.task.due_at ?? Infinity) - (b.task.due_at ?? Infinity));
  const pending = repo.listDecisions(project.id, 'pending');
  const proposed = tasks.filter(t => t.status === 'proposed');
  let next = 'Everything on track. 🙌';
  const top = attention[0];
  if (top?.rank === 0) next = `${mention(top.task.owner_id)}, can you share when **${top.task.title}** will be ready — or ask me to find help?`;
  else if (top?.rank === 1) {
    const b = repo.blockersOf(top.task.id).map(x => repo.getTask(x.blocking_task_id)).find(x => x && x.status !== 'done');
    if (b) next = `${mention(b.owner_id)}, ${repo.memberName(project.id, top.task.owner_id)} is waiting on **${b.title}**.`;
  } else if (pending.length) next = `${pending.length} proposal(s) waiting on confirmation: ${[...new Set(pending.flatMap(p => p.required_approvers.filter(a => !p.approvals.includes(a))))].map(mention).join(', ')}.`;
  else if (proposed.length) next = `${proposed.length} task(s) still need an owner — try \`/claim\`.`;
  return { total: committed.length, done: done.length, attention, pending, proposed, next };
}

/** Compact structured state shared by all agents (instead of re-reading the whole chat). */
export function stateSnapshot(project: Project, nowMs = Date.now()): string {
  const tz = project.timezone;
  const members = repo.listMembers(project.id);
  const tasks = repo.listTasks(project.id);
  const deps = repo.listDependencies(project.id, 'active');
  const reqs = repo.listRequirements(project.id);
  const meetings = repo.listMeetings(project.id, ['collecting', 'confirming', 'confirmed']);
  const pending = repo.listDecisions(project.id, 'pending');
  const lines: string[] = [];
  lines.push(`NOW: ${localStr(nowMs, tz)} (timezone ${tz})`);
  lines.push(`PROJECT: "${project.name}"${project.course ? ` for ${project.course}` : ''}; final deadline: ${localStr(project.final_deadline, tz)}; submitter: ${project.submitter_id ? repo.memberName(project.id, project.submitter_id) : 'not chosen'}; submitted: ${project.submitted_at ? 'YES ' + localStr(project.submitted_at, tz) : 'no'}`);
  lines.push(`MEMBERS (name → discord_id): ${members.map(m => `${m.display_name} → ${m.discord_id}`).join('; ') || 'none yet'}`);
  lines.push(`REQUIREMENTS: ${reqs.length ? reqs.map(r => `[R${r.id}] ${r.title}${r.points ? ` (${r.points} pts)` : ''}`).join('; ') : 'none recorded'}`);
  lines.push('TASKS:');
  if (!tasks.length) lines.push('  (none)');
  for (const t of tasks) {
    const blockers = deps.filter(d => d.dependent_task_id === t.id).map(d => `#${d.blocking_task_id}`);
    lines.push(`  #${t.id} "${t.title}" owner=${t.owner_id ? repo.memberName(project.id, t.owner_id) + '(' + t.owner_id + ')' : 'none'} due=${localStr(t.due_at, tz)} status=${t.status}${t.requirement_id ? ` req=R${t.requirement_id}` : ''}${blockers.length ? ` waits_on=${blockers.join(',')}` : ''}`);
  }
  if (meetings.length) lines.push(`MEETINGS: ${meetings.map(m => `M${m.id} "${m.title}" ${m.status}${m.confirmed_start ? ' at ' + localStr(m.confirmed_start, tz) : ''}`).join('; ')}`);
  if (pending.length) lines.push(`PENDING PROPOSALS: ${pending.map(p => `D${p.id} ${p.kind} awaiting ${p.required_approvers.filter(a => !p.approvals.includes(a)).map(a => repo.memberName(project.id, a)).join(', ')}`).join('; ')}`);
  return lines.join('\n');
}

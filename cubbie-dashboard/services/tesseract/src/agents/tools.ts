import type Anthropic from '@anthropic-ai/sdk';
import * as repo from '../db/repo';
import type { Project } from '../db/repo';
import * as actions from '../core/actions';
import { ActionError, type Out } from '../core/actions';
import { lockMeeting, startMeetingPoll, tallyVotes } from '../core/meetings';
import { checkTaskPlacement } from '../core/constraints';
import { localStr, parseClock, parseDays, parseWhen, WEEKDAY_NAMES, clockStr } from '../core/time';

/**
 * Agent tools. Claude decides WHAT to propose; this file decides what is ALLOWED.
 * Permission rules are enforced in code, not in the prompt:
 *  - nothing assigns work to someone else without their button-click or reply
 *  - only a task's owner can mark it done or move their own deadline
 *  - a student can only record their own class schedule
 *  - only listed approvers can answer a proposal
 */
export type AgentName = 'Planner' | 'Dependency Manager' | 'Meeting Coordinator' | 'Accountability Manager' | 'Assistant';

export interface ToolContext {
  project: Project;
  actorId: string;          // the student whose message triggered this run
  channelId: string;
  sourceUrl?: string;
  agent: AgentName;
  outs: Out[];              // side-effects to deliver to Discord after the run
  notes: string[];          // hand-off notes for the next agent in the chain
}

type ToolDef = Anthropic.Tool & { run: (input: any, ctx: ToolContext) => unknown };

const dueSchema = { type: 'string', description: 'Deadline as ISO 8601 with offset (preferred, e.g. 2026-10-28T18:00:00-07:00) or natural text like "Wednesday 6pm". Use the project timezone.' };

function parseDue(ctx: ToolContext, text: string | undefined | null): number | null {
  if (!text) return null;
  const t = parseWhen(text, ctx.project.timezone);
  if (t == null) throw new ActionError(`Couldn't understand the date "${text}". Use ISO 8601 with offset.`);
  return t;
}
function requireMember(ctx: ToolContext, id: string | undefined | null) {
  if (!id) return null;
  if (!repo.getMember(ctx.project.id, id)) throw new ActionError(`${id} is not a member of this project. Valid members: ${repo.listMembers(ctx.project.id).map(m => `${m.display_name}=${m.discord_id}`).join(', ')}. If they're in the chat but not listed, ask them to run /join.`);
  return id;
}
function requireTask(ctx: ToolContext, id: number) {
  const t = repo.getTask(Number(id));
  if (!t || t.project_id !== ctx.project.id) throw new ActionError(`Task #${id} doesn't exist in this project.`);
  return t;
}
const refresh = (ctx: ToolContext) => { ctx.project = repo.getProject(ctx.project.id)!; };

// ─── Shared ──────────────────────────────────────────────
const get_project_state: ToolDef = {
  name: 'get_project_state',
  description: 'Get the latest structured project state (members, requirements, tasks, dependencies, meetings, pending proposals). Call again after making changes if you need fresh IDs.',
  input_schema: { type: 'object', properties: {} },
  run: (_i, ctx) => actions.stateSnapshot(ctx.project),
};

const respond_to_proposal: ToolDef = {
  name: 'respond_to_proposal',
  description: 'Record the CURRENT SPEAKER\'s answer to a pending proposal (D-number in state) when they clearly accept or decline it in chat, e.g. "confirmed, I\'ll do it". Only works if the speaker is a required approver.',
  input_schema: { type: 'object', properties: { decision_id: { type: 'integer' }, approve: { type: 'boolean' } }, required: ['decision_id', 'approve'] },
  run: (i, ctx) => {
    const r = actions.voteOnDecision(Number(i.decision_id), ctx.actorId, !!i.approve);
    ctx.outs.push(...r.outs);
    return { ok: true, status: r.decision.status, waiting_on: r.decision.required_approvers.filter(a => !r.decision.approvals.includes(a)) };
  },
};

// ─── Planner ─────────────────────────────────────────────
const set_requirements: ToolDef = {
  name: 'set_requirements',
  description: 'Record the deliverables/requirements from the assignment rubric (replaces any existing list). Optionally record the final deadline and submission instructions found in the rubric.',
  input_schema: {
    type: 'object',
    properties: {
      requirements: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, points: { type: 'number' } }, required: ['title'] } },
      final_deadline: dueSchema,
      submission_instructions: { type: 'string', description: 'How/where to submit, e.g. "One member uploads PDF + slides to Canvas"' },
    },
    required: ['requirements'],
  },
  run: (i, ctx) => {
    const reqs = repo.replaceRequirements(ctx.project.id, i.requirements ?? []);
    const fields: Partial<Project> = {};
    if (i.final_deadline && !ctx.project.final_deadline) fields.final_deadline = parseDue(ctx, i.final_deadline);
    if (i.submission_instructions) fields.submission_instructions = i.submission_instructions;
    repo.updateProject(ctx.project.id, fields);
    refresh(ctx);
    if (fields.final_deadline) actions.scheduleSubmissionGuards(ctx.project);
    repo.logAgent(ctx.project.id, ctx.agent, 'requirements_set', { count: reqs.length });
    return { ok: true, requirements: reqs.map(r => ({ id: r.id, title: r.title })), final_deadline: localStr(ctx.project.final_deadline, ctx.project.timezone) };
  },
};

const propose_tasks: ToolDef = {
  name: 'propose_tasks',
  description: 'Propose one or more tasks. With owner_id the owner gets a confirm/decline card (nothing is committed until they accept). If the CURRENT SPEAKER committed to the task themself ("I\'ll do the slides"), set owner_id to the speaker and speaker_committed=true to record it immediately. Without owner_id the task goes on the claim board. Returns constraint conflicts — revise if they matter.',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short, concrete: "Research summary", "Slides 1–8"' },
            description: { type: 'string' },
            owner_id: { type: 'string', description: 'Discord ID from MEMBERS' },
            due: dueSchema,
            requirement_id: { type: 'integer', description: 'R-number this task fulfils, if any' },
            speaker_committed: { type: 'boolean' },
          },
          required: ['title'],
        },
      },
    },
    required: ['tasks'],
  },
  run: (i, ctx) => {
    const results: unknown[] = [];
    const unowned: number[] = [];
    for (const t of i.tasks ?? []) {
      const owner = requireMember(ctx, t.owner_id);
      if (t.requirement_id && !repo.getRequirement(Number(t.requirement_id))) t.requirement_id = null;
      const r = actions.proposeTask(ctx.project, {
        title: t.title, description: t.description, owner_id: owner, due_at: parseDue(ctx, t.due), requirement_id: t.requirement_id ?? null,
        source_url: ctx.sourceUrl, proposedBy: ctx.agent, selfConsent: !!owner && owner === ctx.actorId && !!t.speaker_committed,
      }, ctx.channelId);
      if (!owner) unowned.push(r.task.id); else ctx.outs.push(...r.outs);
      results.push({ task_id: r.task.id, title: r.task.title, status: repo.getTask(r.task.id)!.status, awaiting_confirmation_from: r.decision ? owner : null, conflicts: r.conflicts });
    }
    if (unowned.length) ctx.outs.push({ kind: 'claim_board', projectId: ctx.project.id, taskIds: unowned });
    repo.logAgent(ctx.project.id, ctx.agent, 'tasks_proposed', results);
    return { ok: true, results };
  },
};

// ─── Dependency Manager ──────────────────────────────────
const add_dependency: ToolDef = {
  name: 'add_dependency',
  description: 'Record that dependent_task cannot finish until blocking_task is done (e.g. slides need research). Create the tasks first if they do not exist. Returns timing conflicts.',
  input_schema: { type: 'object', properties: { blocking_task_id: { type: 'integer' }, dependent_task_id: { type: 'integer' }, note: { type: 'string' } }, required: ['blocking_task_id', 'dependent_task_id'] },
  run: (i, ctx) => {
    requireTask(ctx, i.blocking_task_id); requireTask(ctx, i.dependent_task_id);
    const r = actions.addDependencyAction(ctx.project, Number(i.blocking_task_id), Number(i.dependent_task_id), i.note ?? null, ctx.actorId);
    ctx.outs.push(...r.outs);
    return { ok: true, conflicts: r.conflicts };
  },
};

const propose_deadline_change: ToolDef = {
  name: 'propose_deadline_change',
  description: 'Propose moving a task deadline. The owner AND owners of every dependent task must approve via buttons. Returns ripple conflicts (squeezed dependents, affected meetings, final deadline).',
  input_schema: { type: 'object', properties: { task_id: { type: 'integer' }, new_due: dueSchema, reason: { type: 'string' } }, required: ['task_id', 'new_due', 'reason'] },
  run: (i, ctx) => {
    requireTask(ctx, i.task_id);
    const r = actions.proposeDeadlineChange(ctx.project, Number(i.task_id), parseDue(ctx, i.new_due)!, i.reason, ctx.agent);
    ctx.outs.push(...r.outs);
    return { ok: true, conflicts: r.conflicts, note: 'Card posted; waiting for approvals.' };
  },
};

const propose_reassignment: ToolDef = {
  name: 'propose_reassignment',
  description: 'Propose moving a task to another member (e.g. the owner is sick or overloaded). The new owner (and current owner, if they are not the one asking) must approve. Pick someone with capacity — check conflicts.',
  input_schema: { type: 'object', properties: { task_id: { type: 'integer' }, new_owner_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'new_owner_id', 'reason'] },
  run: (i, ctx) => {
    requireTask(ctx, i.task_id); requireMember(ctx, i.new_owner_id);
    const r = actions.proposeReassignment(ctx.project, Number(i.task_id), i.new_owner_id, i.reason, ctx.actorId);
    ctx.outs.push(...r.outs);
    return { ok: true, conflicts: r.conflicts };
  },
};

const check_plan: ToolDef = {
  name: 'check_plan',
  description: 'Run the constraint checker over every open task: overdue items, unconfirmed blockers, tight hand-offs, overloaded members, tasks after the final deadline.',
  input_schema: { type: 'object', properties: {} },
  run: (_i, ctx) => {
    const issues: Record<string, string[]> = {};
    for (const t of repo.listTasks(ctx.project.id, { statuses: repo.OPEN_STATUSES })) {
      const c = checkTaskPlacement(ctx.project, { taskId: t.id, owner_id: t.owner_id, due_at: t.due_at });
      if (c.length) issues[`#${t.id} ${t.title}`] = c;
    }
    const unowned = actions.readiness(ctx.project).unowned.map(r => r.req.title);
    return { issues, rubric_requirements_without_owner: unowned };
  },
};

// ─── Meeting Coordinator ─────────────────────────────────
const record_class_schedule: ToolDef = {
  name: 'record_class_schedule',
  description: 'Save a recurring weekly busy block (class, work, practice) for the CURRENT SPEAKER only. Example: "I have CSE 340 MWF 10:30-11:20" → days "MWF", start "10:30am", end "11:20am", label "CSE 340". Labels stay private.',
  input_schema: { type: 'object', properties: { days: { type: 'string', description: 'e.g. MWF, TTh, Mon/Wed, weekdays' }, start: { type: 'string' }, end: { type: 'string' }, label: { type: 'string' } }, required: ['days', 'start', 'end'] },
  run: (i, ctx) => {
    const days = parseDays(i.days); const s = parseClock(i.start); const e = parseClock(i.end);
    if (!days.length || s == null || e == null || e <= s) throw new ActionError('Could not parse days/times. Example: days="TTh", start="1:30pm", end="2:45pm".');
    repo.upsertMember(ctx.project.id, ctx.actorId, repo.memberName(ctx.project.id, ctx.actorId));
    for (const d of days) repo.addBusyBlock({ project_id: ctx.project.id, discord_id: ctx.actorId, weekday: d, start_min: s, end_min: e, label: i.label ?? null });
    repo.logAgent(ctx.project.id, ctx.agent, 'class_schedule_saved', { user: ctx.actorId, days, s, e });
    return { ok: true, saved: `${days.map(d => WEEKDAY_NAMES[d]).join('/')} ${clockStr(s)}–${clockStr(e)} (label kept private)` };
  },
};

const start_meeting_poll: ToolDef = {
  name: 'start_meeting_poll',
  description: 'Find meeting slots that avoid everyone\'s saved class schedules and post a vote poll. Use when someone wants to meet.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' }, duration_minutes: { type: 'integer', default: 60 }, days_ahead: { type: 'integer', default: 5 },
      earliest_hour: { type: 'integer', description: 'Local hour 0-23, default 9' }, latest_hour: { type: 'integer', description: 'Local hour meeting must end by, default 22' },
      start_date: { type: 'string', description: 'Optional ISO date/time to start searching from (e.g. if they said "this weekend")' },
    },
    required: ['title'],
  },
  run: (i, ctx) => {
    const from = i.start_date ? parseDue(ctx, i.start_date) ?? undefined : undefined;
    const r = startMeetingPoll(ctx.project, { title: i.title, durationMin: i.duration_minutes ?? 60, daysAhead: i.days_ahead ?? 5, earliestHour: i.earliest_hour, latestHour: i.latest_hour, createdBy: ctx.actorId, channelId: ctx.channelId, from: from ? from - 3_600_000 : undefined });
    ctx.outs.push(...r.outs);
    return { ok: true, meeting_id: r.meetingId, options: r.summary, note: 'Poll posted. Members vote with buttons; then someone locks it in.' };
  },
};

const lock_meeting: ToolDef = {
  name: 'lock_meeting',
  description: 'Lock in a meeting slot (best-voted if option_index omitted). Members who did not vote for that slot must confirm.',
  input_schema: { type: 'object', properties: { meeting_id: { type: 'integer' }, option_index: { type: 'integer', description: '0-based' } }, required: ['meeting_id'] },
  run: (i, ctx) => {
    const outs = lockMeeting(ctx.project, Number(i.meeting_id), i.option_index ?? null, ctx.actorId);
    ctx.outs.push(...outs);
    const t = tallyVotes(Number(i.meeting_id));
    return { ok: true, status: t.meeting.status, votes_per_option: t.perOption.map(v => v.length) };
  },
};

// ─── Accountability Manager ──────────────────────────────
const update_task_status: ToolDef = {
  name: 'update_task_status',
  description: 'Update a task the CURRENT SPEAKER owns: done ("finished the research"), in_progress, or blocked. Only the owner can do this.',
  input_schema: { type: 'object', properties: { task_id: { type: 'integer' }, status: { type: 'string', enum: ['done', 'in_progress', 'blocked'] }, note: { type: 'string' } }, required: ['task_id', 'status'] },
  run: (i, ctx) => {
    requireTask(ctx, i.task_id);
    const outs = i.status === 'done'
      ? actions.completeTask(ctx.project, Number(i.task_id), ctx.actorId)
      : actions.setTaskStatus(ctx.project, Number(i.task_id), i.status, ctx.actorId, i.note);
    ctx.outs.push(...outs);
    return { ok: true };
  },
};

const set_my_deadline: ToolDef = {
  name: 'set_my_deadline',
  description: 'Set or change the deadline of a task the CURRENT SPEAKER owns ("I can have research done Wednesday 6pm"). If teammates depend on it, this automatically becomes a proposal they must approve.',
  input_schema: { type: 'object', properties: { task_id: { type: 'integer' }, due: dueSchema }, required: ['task_id', 'due'] },
  run: (i, ctx) => {
    requireTask(ctx, i.task_id);
    const r = actions.setDeadlineDirect(ctx.project, Number(i.task_id), parseDue(ctx, i.due)!, ctx.actorId);
    ctx.outs.push(...r.outs);
    return { ok: true, conflicts: r.conflicts };
  },
};

const schedule_reminder: ToolDef = {
  name: 'schedule_reminder',
  description: 'Schedule a one-off reminder someone asked for ("remind me Thursday at 5 to submit the peer review"). private=true sends a DM instead of posting in the channel.',
  input_schema: { type: 'object', properties: { recipient_id: { type: 'string' }, when: dueSchema, message: { type: 'string' }, private: { type: 'boolean' } }, required: ['recipient_id', 'when', 'message'] },
  run: (i, ctx) => {
    const who = requireMember(ctx, i.recipient_id)!;
    const at = parseDue(ctx, i.when)!;
    if (at < Date.now()) throw new ActionError('That time is in the past.');
    repo.scheduleReminder({ project_id: ctx.project.id, recipient_id: who, kind: 'custom', message: i.message, trigger_at: at, private: !!i.private });
    repo.logAgent(ctx.project.id, ctx.agent, 'reminder_scheduled', { who, at, message: i.message });
    return { ok: true, when: localStr(at, ctx.project.timezone) };
  },
};

const get_status: ToolDef = {
  name: 'get_status',
  description: 'Progress summary: done vs total, what needs attention, pending proposals, rubric coverage.',
  input_schema: { type: 'object', properties: {} },
  run: (_i, ctx) => {
    const s = actions.projectStatus(ctx.project);
    const r = actions.readiness(ctx.project);
    return {
      done: s.done, total: s.total,
      attention: s.attention.slice(0, 8).map(a => ({ task: `#${a.task.id} ${a.task.title}`, owner: repo.memberName(ctx.project.id, a.task.owner_id), reason: a.reason.replace(/<t:(\d+):\w>/g, (_m, x) => localStr(Number(x) * 1000, ctx.project.timezone)) })),
      rubric_missing: r.missing.map(m => `${m.req.title} (${m.state})`),
    };
  },
};

const handoff: ToolDef = {
  name: 'handoff_note',
  description: 'Leave a short note for the next specialist agent in this run (e.g. "Alex can\'t finish research by Wed; Maya\'s slides are blocked; consider reassignment").',
  input_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  run: (i, ctx) => { ctx.notes.push(`${ctx.agent}: ${i.note}`); return { ok: true }; },
};

export const TOOLSETS: Record<Exclude<AgentName, 'Assistant'>, ToolDef[]> & { Assistant: ToolDef[] } = {
  'Planner': [get_project_state, set_requirements, propose_tasks, respond_to_proposal, handoff],
  'Dependency Manager': [get_project_state, add_dependency, propose_deadline_change, propose_reassignment, check_plan, propose_tasks, handoff],
  'Meeting Coordinator': [get_project_state, record_class_schedule, start_meeting_poll, lock_meeting, handoff],
  'Accountability Manager': [get_project_state, update_task_status, set_my_deadline, schedule_reminder, respond_to_proposal, get_status, propose_reassignment, propose_deadline_change, handoff],
  'Assistant': [get_project_state, get_status],
};

export function toolSpecs(agent: AgentName): Anthropic.Tool[] {
  return TOOLSETS[agent].map(({ run, ...spec }) => spec);
}

export async function runTool(agent: AgentName, name: string, input: unknown, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
  const tool = TOOLSETS[agent].find(t => t.name === name);
  if (!tool) return { content: `Unknown tool ${name} for ${agent}`, isError: true };
  try {
    const out = await tool.run(input ?? {}, ctx);
    return { content: typeof out === 'string' ? out : JSON.stringify(out), isError: false };
  } catch (e) {
    const msg = e instanceof ActionError ? e.message : `Internal error: ${(e as Error).message}`;
    repo.logAgent(ctx.project.id, agent, `tool_error:${name}`, msg);
    return { content: msg, isError: true };
  }
}

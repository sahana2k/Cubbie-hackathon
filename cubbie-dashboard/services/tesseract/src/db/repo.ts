import { getDb } from './index';

export type TaskStatus = 'proposed' | 'confirmed' | 'declined' | 'in_progress' | 'blocked' | 'done' | 'overdue';
export const OPEN_STATUSES: TaskStatus[] = ['confirmed', 'in_progress', 'blocked', 'overdue'];

export interface Project {
  id: number; guild_id: string; channel_id: string; name: string; course: string | null;
  final_deadline: number | null; timezone: string; rubric_text: string | null;
  submission_instructions: string | null; submitter_id: string | null; submitted_at: number | null;
  submission_proof: string | null; passive_mode: number; last_passive_at: number;
  created_by: string; created_at: number;
}
export interface Member {
  id: number; project_id: number; discord_id: string; display_name: string;
  reminder_pref: 'minimal' | 'normal' | 'frequent'; dm_reminders: number; joined_at: number;
}
export interface Requirement { id: number; project_id: number; title: string; description: string | null; points: number | null; created_at: number; }
export interface BusyBlock { id: number; project_id: number; discord_id: string; weekday: number; start_min: number; end_min: number; label: string | null; }
export interface Task {
  id: number; project_id: number; title: string; description: string | null; owner_id: string | null;
  due_at: number | null; status: TaskStatus; requirement_id: number | null; source_url: string | null;
  created_by: string | null; created_at: number; updated_at: number; completed_at: number | null;
}
export interface Dependency { id: number; project_id: number; blocking_task_id: number; dependent_task_id: number; state: 'active' | 'resolved'; note: string | null; created_at: number; }
export interface MeetingOption { start: number; end: number; freeCount: number; total: number; }
export interface Meeting {
  id: number; project_id: number; title: string; duration_min: number;
  status: 'collecting' | 'confirming' | 'confirmed' | 'cancelled';
  options: MeetingOption[]; confirmed_start: number | null; created_by: string;
  channel_id: string | null; message_id: string | null; created_at: number;
}
export interface Decision {
  id: number; project_id: number; kind: DecisionKind; payload: any; summary: string;
  required_approvers: string[]; approvals: string[]; rejections: string[]; conflicts: string[];
  status: 'pending' | 'approved' | 'rejected' | 'expired'; proposed_by: string;
  channel_id: string | null; message_id: string | null; created_at: number; resolved_at: number | null;
}
export type DecisionKind = 'assign_task' | 'reassign_task' | 'change_deadline' | 'confirm_meeting' | 'confirm_submission';
export interface Reminder {
  id: number; project_id: number; recipient_id: string | null; task_id: number | null; meeting_id: number | null;
  kind: string; message: string; trigger_at: number; sent_at: number | null; private: number; dedupe_key: string | null;
}

const now = () => Date.now();
const db = () => getDb();

// ─── Projects ────────────────────────────────────────────
export function createProject(p: { guild_id: string; channel_id: string; name: string; course?: string | null; final_deadline?: number | null; timezone: string; created_by: string; }): Project {
  const info = db().prepare(`INSERT INTO projects (guild_id, channel_id, name, course, final_deadline, timezone, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(p.guild_id, p.channel_id, p.name, p.course ?? null, p.final_deadline ?? null, p.timezone, p.created_by, now());
  return getProject(Number(info.lastInsertRowid))!;
}
export function getProject(id: number): Project | undefined {
  return db().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}
export function getProjectByChannel(channelId: string): Project | undefined {
  return db().prepare('SELECT * FROM projects WHERE channel_id = ?').get(channelId) as Project | undefined;
}
export function listProjects(): Project[] {
  return db().prepare('SELECT * FROM projects').all() as Project[];
}
export function updateProject(id: number, fields: Partial<Omit<Project, 'id'>>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db().prepare(`UPDATE projects SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
}

// ─── Members ─────────────────────────────────────────────
export function upsertMember(projectId: number, discordId: string, displayName: string): Member {
  db().prepare(`INSERT INTO members (project_id, discord_id, display_name, joined_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, discord_id) DO UPDATE SET display_name = excluded.display_name`).run(projectId, discordId, displayName, now());
  return getMember(projectId, discordId)!;
}
export function getMember(projectId: number, discordId: string): Member | undefined {
  return db().prepare('SELECT * FROM members WHERE project_id = ? AND discord_id = ?').get(projectId, discordId) as Member | undefined;
}
export function listMembers(projectId: number): Member[] {
  return db().prepare('SELECT * FROM members WHERE project_id = ? ORDER BY joined_at').all(projectId) as Member[];
}
export function updateMember(projectId: number, discordId: string, fields: Partial<Pick<Member, 'reminder_pref' | 'dm_reminders' | 'display_name'>>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db().prepare(`UPDATE members SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE project_id = @pid AND discord_id = @did`).run({ ...fields, pid: projectId, did: discordId });
}
export function memberName(projectId: number, discordId: string | null): string {
  if (!discordId) return 'unassigned';
  return getMember(projectId, discordId)?.display_name ?? `<@${discordId}>`;
}

// ─── Requirements ────────────────────────────────────────
export function replaceRequirements(projectId: number, reqs: { title: string; description?: string | null; points?: number | null }[]): Requirement[] {
  const tx = db().transaction(() => {
    db().prepare('DELETE FROM requirements WHERE project_id = ?').run(projectId);
    const ins = db().prepare('INSERT INTO requirements (project_id, title, description, points, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const r of reqs) ins.run(projectId, r.title, r.description ?? null, r.points ?? null, now());
  });
  tx();
  return listRequirements(projectId);
}
export function listRequirements(projectId: number): Requirement[] {
  return db().prepare('SELECT * FROM requirements WHERE project_id = ? ORDER BY id').all(projectId) as Requirement[];
}
export function getRequirement(id: number): Requirement | undefined {
  return db().prepare('SELECT * FROM requirements WHERE id = ?').get(id) as Requirement | undefined;
}

// ─── Busy blocks (class schedule) ────────────────────────
export function addBusyBlock(b: Omit<BusyBlock, 'id'>): BusyBlock {
  const info = db().prepare('INSERT INTO busy_blocks (project_id, discord_id, weekday, start_min, end_min, label) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.project_id, b.discord_id, b.weekday, b.start_min, b.end_min, b.label ?? null);
  return { ...b, id: Number(info.lastInsertRowid) };
}
export function listBusyBlocks(projectId: number, discordId?: string): BusyBlock[] {
  return discordId
    ? db().prepare('SELECT * FROM busy_blocks WHERE project_id = ? AND discord_id = ? ORDER BY weekday, start_min').all(projectId, discordId) as BusyBlock[]
    : db().prepare('SELECT * FROM busy_blocks WHERE project_id = ? ORDER BY weekday, start_min').all(projectId) as BusyBlock[];
}
export function clearBusyBlocks(projectId: number, discordId: string) {
  db().prepare('DELETE FROM busy_blocks WHERE project_id = ? AND discord_id = ?').run(projectId, discordId);
}

// ─── Tasks ───────────────────────────────────────────────
export function createTask(t: { project_id: number; title: string; description?: string | null; owner_id?: string | null; due_at?: number | null; status?: TaskStatus; requirement_id?: number | null; source_url?: string | null; created_by?: string | null; }): Task {
  const ts = now();
  const info = db().prepare(`INSERT INTO tasks (project_id, title, description, owner_id, due_at, status, requirement_id, source_url, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.project_id, t.title, t.description ?? null, t.owner_id ?? null, t.due_at ?? null, t.status ?? 'proposed',
    t.requirement_id ?? null, t.source_url ?? null, t.created_by ?? null, ts, ts);
  return getTask(Number(info.lastInsertRowid))!;
}
export function getTask(id: number): Task | undefined {
  return db().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}
export function listTasks(projectId: number, opts: { statuses?: TaskStatus[]; ownerId?: string } = {}): Task[] {
  let sql = 'SELECT * FROM tasks WHERE project_id = ?';
  const args: unknown[] = [projectId];
  if (opts.statuses?.length) { sql += ` AND status IN (${opts.statuses.map(() => '?').join(',')})`; args.push(...opts.statuses); }
  if (opts.ownerId) { sql += ' AND owner_id = ?'; args.push(opts.ownerId); }
  sql += ' ORDER BY (due_at IS NULL), due_at, id';
  return db().prepare(sql).all(...args) as Task[];
}
export function updateTask(id: number, fields: Partial<Omit<Task, 'id' | 'project_id' | 'created_at'>>) {
  const f: Record<string, unknown> = { ...fields, updated_at: now() };
  if (fields.status === 'done' && fields.completed_at === undefined) f.completed_at = now();
  const keys = Object.keys(f);
  db().prepare(`UPDATE tasks SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id });
}

// ─── Dependencies ────────────────────────────────────────
export function addDependency(projectId: number, blockingId: number, dependentId: number, note?: string | null): Dependency {
  db().prepare(`INSERT INTO dependencies (project_id, blocking_task_id, dependent_task_id, note, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(blocking_task_id, dependent_task_id) DO UPDATE SET state = 'active', note = COALESCE(excluded.note, dependencies.note)`)
    .run(projectId, blockingId, dependentId, note ?? null, now());
  return db().prepare('SELECT * FROM dependencies WHERE blocking_task_id = ? AND dependent_task_id = ?').get(blockingId, dependentId) as Dependency;
}
export function listDependencies(projectId: number, state?: 'active' | 'resolved'): Dependency[] {
  return state
    ? db().prepare('SELECT * FROM dependencies WHERE project_id = ? AND state = ?').all(projectId, state) as Dependency[]
    : db().prepare('SELECT * FROM dependencies WHERE project_id = ?').all(projectId) as Dependency[];
}
export function blockersOf(taskId: number): Dependency[] {
  return db().prepare("SELECT * FROM dependencies WHERE dependent_task_id = ? AND state = 'active'").all(taskId) as Dependency[];
}
export function dependentsOf(taskId: number): Dependency[] {
  return db().prepare("SELECT * FROM dependencies WHERE blocking_task_id = ? AND state = 'active'").all(taskId) as Dependency[];
}
export function resolveDependenciesFor(blockingTaskId: number) {
  db().prepare("UPDATE dependencies SET state = 'resolved' WHERE blocking_task_id = ?").run(blockingTaskId);
}

// ─── Meetings ────────────────────────────────────────────
function hydrateMeeting(row: any): Meeting | undefined {
  if (!row) return undefined;
  return { ...row, options: JSON.parse(row.options) };
}
export function createMeeting(m: { project_id: number; title: string; duration_min: number; options: MeetingOption[]; created_by: string; channel_id?: string | null }): Meeting {
  const info = db().prepare('INSERT INTO meetings (project_id, title, duration_min, options, created_by, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(m.project_id, m.title, m.duration_min, JSON.stringify(m.options), m.created_by, m.channel_id ?? null, now());
  return getMeeting(Number(info.lastInsertRowid))!;
}
export function getMeeting(id: number): Meeting | undefined {
  return hydrateMeeting(db().prepare('SELECT * FROM meetings WHERE id = ?').get(id));
}
export function listMeetings(projectId: number, statuses?: Meeting['status'][]): Meeting[] {
  const rows = statuses?.length
    ? db().prepare(`SELECT * FROM meetings WHERE project_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY id DESC`).all(projectId, ...statuses)
    : db().prepare('SELECT * FROM meetings WHERE project_id = ? ORDER BY id DESC').all(projectId);
  return rows.map(hydrateMeeting) as Meeting[];
}
export function updateMeeting(id: number, fields: Partial<Omit<Meeting, 'id'>>) {
  const f: Record<string, unknown> = { ...fields };
  if (fields.options) f.options = JSON.stringify(fields.options);
  const keys = Object.keys(f);
  if (!keys.length) return;
  db().prepare(`UPDATE meetings SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id });
}
export function toggleVote(meetingId: number, optionIndex: number, discordId: string): boolean {
  const exists = db().prepare('SELECT 1 FROM meeting_votes WHERE meeting_id = ? AND option_index = ? AND discord_id = ?').get(meetingId, optionIndex, discordId);
  if (exists) {
    db().prepare('DELETE FROM meeting_votes WHERE meeting_id = ? AND option_index = ? AND discord_id = ?').run(meetingId, optionIndex, discordId);
    return false;
  }
  db().prepare('INSERT INTO meeting_votes (meeting_id, option_index, discord_id) VALUES (?, ?, ?)').run(meetingId, optionIndex, discordId);
  return true;
}
export function votesFor(meetingId: number): { option_index: number; discord_id: string }[] {
  return db().prepare('SELECT option_index, discord_id FROM meeting_votes WHERE meeting_id = ?').all(meetingId) as any[];
}

// ─── Decisions ───────────────────────────────────────────
function hydrateDecision(row: any): Decision | undefined {
  if (!row) return undefined;
  return {
    ...row, payload: JSON.parse(row.payload), required_approvers: JSON.parse(row.required_approvers),
    approvals: JSON.parse(row.approvals), rejections: JSON.parse(row.rejections), conflicts: JSON.parse(row.conflicts),
  };
}
export function createDecision(d: { project_id: number; kind: DecisionKind; payload: unknown; summary: string; required_approvers: string[]; conflicts?: string[]; proposed_by: string; channel_id?: string | null; }): Decision {
  const info = db().prepare(`INSERT INTO decisions (project_id, kind, payload, summary, required_approvers, conflicts, proposed_by, channel_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d.project_id, d.kind, JSON.stringify(d.payload), d.summary, JSON.stringify([...new Set(d.required_approvers)]),
    JSON.stringify(d.conflicts ?? []), d.proposed_by, d.channel_id ?? null, now());
  return getDecision(Number(info.lastInsertRowid))!;
}
export function getDecision(id: number): Decision | undefined {
  return hydrateDecision(db().prepare('SELECT * FROM decisions WHERE id = ?').get(id));
}
export function listDecisions(projectId: number, status?: Decision['status']): Decision[] {
  const rows = status
    ? db().prepare('SELECT * FROM decisions WHERE project_id = ? AND status = ? ORDER BY id').all(projectId, status)
    : db().prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY id').all(projectId);
  return rows.map(hydrateDecision) as Decision[];
}
export function updateDecision(id: number, fields: Partial<Pick<Decision, 'approvals' | 'rejections' | 'status' | 'message_id' | 'channel_id' | 'resolved_at'>>) {
  const f: Record<string, unknown> = { ...fields };
  if (fields.approvals) f.approvals = JSON.stringify(fields.approvals);
  if (fields.rejections) f.rejections = JSON.stringify(fields.rejections);
  const keys = Object.keys(f);
  if (!keys.length) return;
  db().prepare(`UPDATE decisions SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id });
}

// ─── Reminders ───────────────────────────────────────────
/** Inserts unless a reminder with the same dedupe key already exists. Returns true if inserted. */
export function scheduleReminder(r: { project_id: number; recipient_id?: string | null; task_id?: number | null; meeting_id?: number | null; kind: string; message: string; trigger_at: number; private?: boolean; dedupe_key?: string | null; }): boolean {
  const info = db().prepare(`INSERT INTO reminders (project_id, recipient_id, task_id, meeting_id, kind, message, trigger_at, private, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(r.project_id, r.recipient_id ?? null, r.task_id ?? null, r.meeting_id ?? null, r.kind, r.message,
    r.trigger_at, r.private ? 1 : 0, r.dedupe_key ?? null);
  return info.changes > 0;
}
export function dueReminders(at: number): Reminder[] {
  return db().prepare('SELECT * FROM reminders WHERE sent_at IS NULL AND trigger_at <= ? ORDER BY trigger_at LIMIT 50').all(at) as Reminder[];
}
export function markReminderSent(id: number) {
  db().prepare('UPDATE reminders SET sent_at = ? WHERE id = ?').run(now(), id);
}
export function cancelTaskReminders(taskId: number) {
  db().prepare('UPDATE reminders SET sent_at = -1 WHERE task_id = ? AND sent_at IS NULL').run(taskId);
}
export function listPendingReminders(projectId: number): Reminder[] {
  return db().prepare('SELECT * FROM reminders WHERE project_id = ? AND sent_at IS NULL ORDER BY trigger_at').all(projectId) as Reminder[];
}

// ─── Agent log & chat memory ─────────────────────────────
export function logAgent(projectId: number | null, agent: string, action: string, detail?: unknown) {
  db().prepare('INSERT INTO agent_log (project_id, agent, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, agent, action, detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail), now());
}
export function recentAgentLog(projectId: number, limit = 15) {
  return db().prepare('SELECT * FROM agent_log WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as
    { id: number; agent: string; action: string; detail: string | null; created_at: number }[];
}
export function logChat(projectId: number, authorId: string, authorName: string, content: string, url?: string) {
  db().prepare('INSERT INTO chat_log (project_id, author_id, author_name, content, message_url, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(projectId, authorId, authorName, content.slice(0, 2000), url ?? null, now());
  // keep the most recent 300 messages per project
  db().prepare(`DELETE FROM chat_log WHERE project_id = ? AND id NOT IN (SELECT id FROM chat_log WHERE project_id = ? ORDER BY id DESC LIMIT 300)`).run(projectId, projectId);
}
export function recentChat(projectId: number, limit = 30) {
  const rows = db().prepare('SELECT author_name, content, created_at FROM chat_log WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as
    { author_name: string; content: string; created_at: number }[];
  return rows.reverse();
}

export function agentLogSince(projectId: number, sinceMs: number) {
  return db().prepare('SELECT * FROM agent_log WHERE project_id = ? AND created_at >= ? ORDER BY id').all(projectId, sinceMs) as
    { id: number; agent: string; action: string; detail: string | null; created_at: number }[];
}

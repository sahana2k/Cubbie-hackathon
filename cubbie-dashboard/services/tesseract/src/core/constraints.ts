import * as repo from '../db/repo';
import { OPEN_STATUSES, type Project, type Task } from '../db/repo';
import { HOUR, localStr } from './time';

/**
 * Deterministic constraint checker shared by every agent. Agents propose; this module
 * checks the proposal against the shared project state and returns human-readable
 * conflicts. Conflicts are (a) fed back to the agent so it can revise, and
 * (b) printed on the confirmation card so students decide with full information.
 */

const HANDOFF_BUFFER = 12 * HOUR; // a dependent task needs at least this long after its blocker is done
const OVERLOAD_WINDOW = 48 * HOUR;
const OVERLOAD_LIMIT = 3;

export function checkTaskPlacement(project: Project, p: { taskId?: number; owner_id?: string | null; due_at?: number | null }, nowMs = Date.now()): string[] {
  const out: string[] = [];
  const tz = project.timezone;
  const name = (id: string | null | undefined) => repo.memberName(project.id, id ?? null);

  if (p.due_at != null) {
    if (p.due_at < nowMs) out.push(`The due date (${localStr(p.due_at, tz)}) is already in the past.`);
    if (project.final_deadline && p.due_at > project.final_deadline)
      out.push(`Due ${localStr(p.due_at, tz)} is after the final project deadline (${localStr(project.final_deadline, tz)}).`);
    else if (project.final_deadline && project.final_deadline - p.due_at < 6 * HOUR && p.due_at <= project.final_deadline)
      out.push(`Due within 6 hours of the final deadline — very little slack for integration or fixes.`);
  }

  if (p.owner_id && p.due_at != null) {
    const clustered = repo.listTasks(project.id, { statuses: OPEN_STATUSES, ownerId: p.owner_id })
      .filter(t => t.id !== p.taskId && t.due_at != null && Math.abs(t.due_at - p.due_at!) <= OVERLOAD_WINDOW);
    if (clustered.length + 1 >= OVERLOAD_LIMIT)
      out.push(`${name(p.owner_id)} would have ${clustered.length + 1} tasks due within 48 hours of each other (${clustered.map(t => `"${t.title}"`).join(', ')}).`);
  }

  if (p.taskId && p.due_at != null) {
    for (const dep of repo.blockersOf(p.taskId)) {
      const blocker = repo.getTask(dep.blocking_task_id);
      if (!blocker || blocker.status === 'done' || blocker.due_at == null) continue;
      if (blocker.due_at + HANDOFF_BUFFER > p.due_at)
        out.push(`It depends on "${blocker.title}" (${name(blocker.owner_id)}), due ${localStr(blocker.due_at, tz)} — less than 12h of hand-off time.`);
    }
    for (const dep of repo.dependentsOf(p.taskId)) {
      const dependent = repo.getTask(dep.dependent_task_id);
      if (!dependent || dependent.due_at == null || ['done', 'declined'].includes(dependent.status)) continue;
      if (p.due_at + HANDOFF_BUFFER > dependent.due_at)
        out.push(`"${dependent.title}" (${name(dependent.owner_id)}) is waiting on this and is due ${localStr(dependent.due_at, tz)} — it would be squeezed or blocked.`);
    }
  }
  return out;
}

/** Would adding blocking → dependent create a cycle? */
export function createsCycle(projectId: number, blockingId: number, dependentId: number): boolean {
  if (blockingId === dependentId) return true;
  const edges = repo.listDependencies(projectId, 'active');
  // Walk forward from dependent; if we can reach blocking, adding the edge closes a loop.
  const stack = [dependentId];
  const seen = new Set<number>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === blockingId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edges) if (e.blocking_task_id === cur) stack.push(e.dependent_task_id);
  }
  return false;
}

export function checkDependency(project: Project, blocking: Task, dependent: Task): string[] {
  const out: string[] = [];
  if (createsCycle(project.id, blocking.id, dependent.id)) out.push(`That would create a circular dependency between "${blocking.title}" and "${dependent.title}".`);
  if (blocking.due_at && dependent.due_at && blocking.due_at + HANDOFF_BUFFER > dependent.due_at)
    out.push(`"${blocking.title}" is due ${localStr(blocking.due_at, project.timezone)}, but "${dependent.title}" is due ${localStr(dependent.due_at, project.timezone)} — not enough hand-off time.`);
  if (blocking.status === 'proposed') out.push(`"${blocking.title}" isn't confirmed by an owner yet, so "${dependent.title}" is at risk.`);
  return out;
}

/** Ripple effects of moving a deadline: squeezed dependents, affected meetings, final deadline. */
export function deadlineRipple(project: Project, task: Task, newDue: number): { conflicts: string[]; affectedOwners: string[] } {
  const conflicts = checkTaskPlacement(project, { taskId: task.id, owner_id: task.owner_id, due_at: newDue });
  const affected = new Set<string>();
  for (const dep of repo.dependentsOf(task.id)) {
    const d = repo.getTask(dep.dependent_task_id);
    if (d?.owner_id && d.owner_id !== task.owner_id) affected.add(d.owner_id);
  }
  const oldDue = task.due_at ?? Date.now();
  for (const m of repo.listMeetings(project.id, ['confirmed'])) {
    if (m.confirmed_start && m.confirmed_start > oldDue && m.confirmed_start < newDue)
      conflicts.push(`The team meeting "${m.title}" (${localStr(m.confirmed_start, project.timezone)}) was planned for after this would be done.`);
  }
  return { conflicts, affectedOwners: [...affected] };
}

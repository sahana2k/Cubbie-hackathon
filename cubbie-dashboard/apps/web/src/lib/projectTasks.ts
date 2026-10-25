/** Completion remains in project history but no longer occupies an active member card. */
export function activeProjectTasks<T extends { status: string }>(tasks: T[]): T[] {
  return tasks.filter(task => task.status !== 'done' && task.status !== 'declined');
}

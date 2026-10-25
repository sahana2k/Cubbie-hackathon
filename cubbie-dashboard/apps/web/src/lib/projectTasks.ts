/** Completion remains in project history but no longer occupies an active member card. */
export function activeProjectTasks<T extends { status: string }>(tasks: T[]): T[] {
  return tasks.filter(task => task.status !== 'done' && task.status !== 'declined');
}

export interface ProjectChannel { id: string; name: string; project?: { name: string; activeTasks: number } | null }

/** Keep an explicit selection; otherwise open the channel that has project work. */
export function defaultProjectChannel(channels: ProjectChannel[], saved: string): string {
  return channels.find(channel => channel.id === saved)?.id
    || channels.find(channel => channel.project && channel.project.activeTasks > 0)?.id
    || channels.find(channel => channel.project)?.id || channels[0]?.id || '';
}

export function projectTaskColumns<T extends { status: string; owner_id: string | null; title: string; description: string | null }>(
  tasks: T[], members: { id: string; name: string }[], query = '', includeEmpty = false
) {
  const names = new Map(members.map(member => [member.id, member.name]));
  const groups = new Map<string, { id: string; name: string; tasks: T[] }>();
  if (includeEmpty && !query.trim()) {
    for (const member of members) groups.set(member.id, { ...member, tasks: [] });
    groups.set('', { id: '', name: 'Unassigned', tasks: [] });
  }
  for (const task of activeProjectTasks(tasks)) {
    const id = task.owner_id || '';
    const name = id ? names.get(id) || 'Discord teammate' : 'Unassigned';
    if (!`${task.title} ${task.description || ''} ${name}`.toLowerCase().includes(query.trim().toLowerCase())) continue;
    if (!groups.has(id)) groups.set(id, { id, name, tasks: [] });
    groups.get(id)!.tasks.push(task);
  }
  return [...groups.values()].sort((a, b) => !a.id ? 1 : !b.id ? -1 : a.name.localeCompare(b.name));
}

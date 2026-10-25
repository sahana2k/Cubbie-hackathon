import { closeDb, initDb } from '../src/db/index';
import * as repo from '../src/db/repo';

export const TZ = 'America/Phoenix';
export const ALEX = '100000000000000001';
export const MAYA = '100000000000000002';
export const SAM = '100000000000000003';
export const JORDAN = '100000000000000004';

export function freshProject(deadlineInDays = 7) {
  closeDb();
  initDb(':memory:');
  const p = repo.createProject({ guild_id: 'g1', channel_id: 'c1', name: 'CSE 360 Team Project', course: 'CSE 360', final_deadline: Date.now() + deadlineInDays * 86_400_000, timezone: TZ, created_by: ALEX });
  repo.upsertMember(p.id, ALEX, 'Alex');
  repo.upsertMember(p.id, MAYA, 'Maya');
  repo.upsertMember(p.id, SAM, 'Sam');
  return p;
}

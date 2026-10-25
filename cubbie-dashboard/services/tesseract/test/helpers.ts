import { closeDb, getDb, initDb } from '../src/db/index';
import * as repo from '../src/db/repo';

export const TZ = 'America/Phoenix';
export const ALEX = '100000000000000001';
export const MAYA = '100000000000000002';
export const SAM = '100000000000000003';
export const JORDAN = '100000000000000004';

let db = false;

export function freshProject(deadlineInDays = 7) {
  // TEST_DATABASE_URL=postgresql://… runs the whole suite against PostgreSQL; default is in-memory SQLite.
  const pgUrl = process.env.TEST_DATABASE_URL;
  if (pgUrl) {
    if (!db) { initDb(pgUrl); db = true; }
    getDb().exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    closeDb();
    initDb(pgUrl);
  } else {
    closeDb();
    initDb(':memory:');
  }
  const p = repo.createProject({ guild_id: 'g1', channel_id: 'c1', name: 'CSE 360 Team Project', course: 'CSE 360', final_deadline: Date.now() + deadlineInDays * 86_400_000, timezone: TZ, created_by: ALEX });
  repo.upsertMember(p.id, ALEX, 'Alex');
  repo.upsertMember(p.id, MAYA, 'Maya');
  repo.upsertMember(p.id, SAM, 'Sam');
  return p;
}

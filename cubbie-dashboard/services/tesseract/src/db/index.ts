import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createSyncFn } from 'synckit';

/**
 * Single SQLite database. All timestamps are INTEGER epoch milliseconds (UTC).
 * The database is the source of truth for confirmed commitments — AI output only
 * ever lands here as `proposed` rows or pending `decisions` until humans confirm.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  course TEXT,
  final_deadline INTEGER,
  timezone TEXT NOT NULL,
  rubric_text TEXT,
  submission_instructions TEXT,
  submitter_id TEXT,
  submitted_at INTEGER,
  submission_proof TEXT,
  passive_mode INTEGER NOT NULL DEFAULT 1,
  last_passive_at INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  discord_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  reminder_pref TEXT NOT NULL DEFAULT 'normal',   -- minimal | normal | frequent
  dm_reminders INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  UNIQUE(project_id, discord_id)
);

CREATE TABLE IF NOT EXISTS requirements (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  points REAL,
  created_at INTEGER NOT NULL
);

-- Recurring weekly busy time (classes, work). Labels are private and never posted.
CREATE TABLE IF NOT EXISTS busy_blocks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  discord_id TEXT NOT NULL,
  weekday INTEGER NOT NULL,      -- 1 = Monday … 7 = Sunday (ISO)
  start_min INTEGER NOT NULL,    -- minutes after local midnight
  end_min INTEGER NOT NULL,
  label TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  owner_id TEXT,
  due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'proposed', -- proposed|confirmed|declined|in_progress|blocked|done|overdue
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  source_url TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  blocking_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependent_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'active',  -- active | resolved
  note TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(blocking_task_id, dependent_task_id)
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting', -- collecting | confirming | confirmed | cancelled
  options TEXT NOT NULL DEFAULT '[]',        -- JSON [{start,end,freeCount,total}]
  confirmed_start INTEGER,
  created_by TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_votes (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  discord_id TEXT NOT NULL,
  PRIMARY KEY (meeting_id, option_index, discord_id)
);

-- Anything that needs human consent: task assignment, reassignment, deadline change,
-- meeting confirmation, rescue plan, submission confirmation.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  required_approvers TEXT NOT NULL,  -- JSON string[]
  approvals TEXT NOT NULL DEFAULT '[]',
  rejections TEXT NOT NULL DEFAULT '[]',
  conflicts TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired
  proposed_by TEXT NOT NULL,             -- agent name or discord id
  channel_id TEXT,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recipient_id TEXT,          -- NULL = post to the project channel
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  meeting_id INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  trigger_at INTEGER NOT NULL,
  sent_at INTEGER,
  private INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS agent_log (
  id INTEGER PRIMARY KEY,
  project_id INTEGER,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_log (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  message_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(sent_at, trigger_at);
CREATE INDEX IF NOT EXISTS idx_chat_project ON chat_log(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id, status);
`;

/** The same schema, translated for PostgreSQL: ms timestamps need 64-bit columns. */
export function postgresSchema(sqlite: string = SCHEMA): string {
  return sqlite
    .replace(/^PRAGMA .*$/gm, '')
    .replace(/INTEGER PRIMARY KEY/g, 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY')
    .replace(/\bINTEGER\b/g, 'BIGINT')
    .replace(/\bREAL\b/g, 'DOUBLE PRECISION');
}

/**
 * The subset of the better-sqlite3 API that repo.ts uses. SQLite (tests, local dev) returns
 * better-sqlite3 itself; PostgreSQL (production, DATABASE_URL=postgres://...) returns an
 * adapter with the same synchronous methods, so repo.ts and its ~230 callers stay unchanged.
 */
export interface RunResult { changes: number; lastInsertRowid: number | bigint }
export interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}
export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

type PgCall = (op: 'query' | 'close', sql?: string, params?: unknown[]) => { rows: any[]; rowCount: number };

/** Converts better-sqlite3 placeholders (? and @name) to PostgreSQL's $1, $2 … outside quoted strings. */
export function toPgParams(sql: string, params: unknown[]): { text: string; values: unknown[] } {
  const named = params.length === 1 && params[0] !== null && typeof params[0] === 'object' && !Array.isArray(params[0])
    ? params[0] as Record<string, unknown> : null;
  const values: unknown[] = [];
  let text = '', i = 0, positional = 0, quoted = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") { quoted = !quoted; text += ch; i++; continue; }
    if (!quoted && ch === '?') { values.push(params[positional++]); text += `$${values.length}`; i++; continue; }
    if (!quoted && ch === '@' && named) {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        if (!(m[1] in named)) throw new Error(`Missing named parameter @${m[1]}`);
        values.push(named[m[1]]); text += `$${values.length}`; i += m[0].length; continue;
      }
    }
    text += ch; i++;
  }
  return { text, values };
}

function postgresDb(): Db {
  const call = createSyncFn(path.join(__dirname, 'pgWorker.cjs'), { timeout: 30_000 }) as unknown as PgCall;
  const query = (sql: string, params: unknown[] = []) => call('query', sql, params);
  query('SELECT 1'); // fail fast at startup if the database is unreachable
  return {
    prepare(sql) {
      return {
        get: (...p) => { const { text, values } = toPgParams(sql, p); return query(text, values).rows[0]; },
        all: (...p) => { const { text, values } = toPgParams(sql, p); return query(text, values).rows; },
        run: (...p) => {
          let { text, values } = toPgParams(sql, p);
          const isInsert = /^\s*insert\b/i.test(text) && !/\breturning\b/i.test(text);
          if (isInsert) text += ' RETURNING *';
          const r = query(text, values);
          return { changes: r.rowCount ?? 0, lastInsertRowid: isInsert && r.rows[0]?.id != null ? Number(r.rows[0].id) : 0 };
        },
      };
    },
    exec: sql => { query(sql); },
    transaction<T>(fn: () => T) {
      return () => {
        query('BEGIN');
        try { const out = fn(); query('COMMIT'); return out; }
        catch (e) { query('ROLLBACK'); throw e; }
      };
    },
    close: () => { call('close'); },
  };
}

let db: Db | null = null;

/** `target` is a PostgreSQL URL (production) or a SQLite file path / ':memory:' (tests, local dev). */
export function initDb(target: string): Db {
  if (/^postgres(ql)?:\/\//.test(target)) {
    process.env.TESSERACT_PG_URL = target; // read by the worker thread
    db = postgresDb();
    db.exec(postgresSchema());
    return db;
  }
  if (target !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  const sqlite = new Database(target);
  sqlite.exec(SCHEMA);
  db = sqlite as unknown as Db;
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not initialised — call initDb() first');
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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

let db: Database.Database | null = null;

export function initDb(file: string): Database.Database {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised — call initDb() first');
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

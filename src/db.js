import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  prompt      TEXT NOT NULL,
  engine      TEXT NOT NULL DEFAULT 'claude',
  cwd         TEXT,
  stream      INTEGER NOT NULL DEFAULT 0, -- 0 = buffered (default), 1 = stream-json
  concise     INTEGER NOT NULL DEFAULT 1, -- 1 = concise answer (default), 0 = full
  status      TEXT NOT NULL,              -- queued | running | done | failed | canceled
  output      TEXT,
  error       TEXT,
  exit_code   INTEGER,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  name  TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,   -- uuid; also used as claude --session-id
  name                 TEXT NOT NULL,
  engine               TEXT NOT NULL,      -- claude | codex | openai | anthropic
  summary              TEXT,               -- compressed history summary (API)
  turns_before_summary INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
`;

// Lightweight migrations for databases created by an earlier version.
function migrate(db) {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all().map((c) => c.name);
  if (!cols.includes('stream')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN stream INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('concise')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN concise INTEGER NOT NULL DEFAULT 1`);
  }
  if (!cols.includes('session_id')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN session_id TEXT`);
  }
}

/**
 * Open (or create) the SQLite database and ensure the schema exists.
 * Pass ':memory:' for an ephemeral DB (used by tests).
 */
export function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function insertTask(db, task) {
  db.prepare(
    `INSERT INTO tasks (id, prompt, engine, cwd, stream, concise, session_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
  ).run(
    task.id, task.prompt, task.engine, task.cwd ?? null,
    task.stream ? 1 : 0, task.concise ? 1 : 0, task.session_id ?? null, task.created_at
  );
  return getTask(db, task.id);
}

export function getSetting(db, name) {
  const row = db.prepare('SELECT value FROM settings WHERE name = ?').get(name);
  return row ? row.value : null;
}
export function setSetting(db, name, value) {
  db.prepare(
    `INSERT INTO settings (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value`
  ).run(name, value);
}

/** Append streamed output to a task incrementally. */
export function appendOutput(db, id, text) {
  db.prepare(`UPDATE tasks SET output = COALESCE(output, '') || ? WHERE id = ?`).run(text, id);
}

export function getTask(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? null;
}

export function markRunning(db, id, startedAt) {
  db.prepare(`UPDATE tasks SET status='running', started_at=? WHERE id=?`).run(startedAt, id);
}

export function markFinished(db, id, { status, output, error, exitCode, finishedAt }) {
  db.prepare(
    `UPDATE tasks SET status=?, output=?, error=?, exit_code=?, finished_at=? WHERE id=?`
  ).run(status, output ?? null, error ?? null, exitCode ?? null, finishedAt, id);
  return getTask(db, id);
}

// Columns returned by the list endpoint — deliberately EXCLUDES the heavy
// `output`/`error` fields so history pages stay small. The full task (with
// output/error) is fetched on demand via getTask when a card is opened.
const LIST_COLS =
  'id, prompt, engine, cwd, stream, concise, status, exit_code, created_at, started_at, finished_at';

/**
 * Cursor-paginated history, newest first.
 * cursor = created_at of the last item from the previous page (exclusive).
 * Rows omit output/error to keep the payload light.
 */
export function listTasks(db, { cursor, limit = 20, sessionId } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const where = [];
  const params = [];
  if (sessionId) { where.push('session_id = ?'); params.push(sessionId); }
  if (cursor) { where.push('created_at < ?'); params.push(Number(cursor)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT ${LIST_COLS} FROM tasks ${clause} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, lim + 1);
  const hasMore = rows.length > lim;
  const items = rows.slice(0, lim);
  const nextCursor = hasMore ? items[items.length - 1].created_at : null;
  return { items, nextCursor };
}

export function getQueuedIds(db) {
  return db
    .prepare(`SELECT id FROM tasks WHERE status='queued' ORDER BY created_at ASC`)
    .all()
    .map((r) => r.id);
}

/**
 * On startup, any task still marked 'running' is an orphan from a previous
 * crash/restart; fail it so the queue is in a clean state.
 */
export function failOrphans(db, finishedAt) {
  const orphans = db.prepare(`SELECT id FROM tasks WHERE status='running'`).all();
  for (const { id } of orphans) {
    markFinished(db, id, {
      status: 'failed',
      error: 'Interrupted by server restart',
      exitCode: null,
      finishedAt,
    });
  }
  return orphans.length;
}

// --- sessions --------------------------------------------------------------
export function createSession(db, { id, name, engine, now }) {
  db.prepare(
    `INSERT INTO sessions (id, name, engine, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, engine, now, now);
  return getSession(db, id);
}
export function getSession(db, id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) ?? null;
}
export function listSessions(db, { engine } = {}) {
  if (engine) {
    return db.prepare('SELECT * FROM sessions WHERE engine = ? ORDER BY updated_at DESC').all(engine);
  }
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
}
export function renameSession(db, id, name, now) {
  db.prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id);
  return getSession(db, id);
}
export function touchSession(db, id, now) {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, id);
}
export function setSessionSummary(db, id, summary, turnsBeforeSummary, now) {
  db.prepare('UPDATE sessions SET summary = ?, turns_before_summary = ?, updated_at = ? WHERE id = ?')
    .run(summary, turnsBeforeSummary, now, id);
  return getSession(db, id);
}
/** Delete a session and all its tasks. Returns number of tasks removed. */
export function deleteSession(db, id) {
  const n = db.prepare('SELECT COUNT(*) c FROM tasks WHERE session_id = ?').get(id).c;
  db.prepare('DELETE FROM tasks WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return n;
}
/** Finished tasks in a session, oldest first (for building conversation history). */
export function sessionHistory(db, id) {
  return db.prepare(
    `SELECT prompt, output, status FROM tasks
     WHERE session_id = ? AND status = 'done'
     ORDER BY created_at ASC`
  ).all(id);
}
